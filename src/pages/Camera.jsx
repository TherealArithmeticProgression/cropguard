import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getRecentPredictions, savePrediction } from '../db/indexedDB'
import { predictDiseaseOffline } from '../services/offlineInference'
import Icon from '../components/Icon'

const TOTAL_SHOTS = 3;
// Below this, a shot is flagged as likely blurry. Tuned by eye against a
// handful of sharp vs. deliberately-blurred test photos -- retune once
// Akshar has real field images to check this against.
const BLUR_VARIANCE_THRESHOLD = 18;

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
}

/**
 * Lightweight, dependency-free blur estimate: downsamples the frame, converts
 * to grayscale, and measures how much pixel-to-pixel variation exists. Sharp,
 * in-focus leaf texture has high variation; a blurry photo is smoother and
 * scores lower. This is a real (if simple) stand-in for the Laplacian-variance
 * quality gate discussed in the implementation plan -- not a full computer-
 * vision library, but enough to catch an obviously unusable photo before it's
 * ever sent anywhere.
 */
function estimateSharpness(canvas) {
  const size = 96;
  const small = document.createElement('canvas');
  small.width = size;
  small.height = size;
  const ctx = small.getContext('2d');
  ctx.drawImage(canvas, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const gray = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }

  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const idx = y * size + x;
      const gx = gray[idx + 1] - gray[idx - 1];
      const gy = gray[idx + size] - gray[idx - size];
      const grad = Math.sqrt(gx * gx + gy * gy);
      sum += grad;
      sumSq += grad * grad;
      count++;
    }
  }
  const mean = sum / count;
  const variance = sumSq / count - mean * mean;
  return variance;
}

function Camera() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const galleryInputRef = useRef(null);
  const [stream, setStream] = useState(null);
  const [shots, setShots] = useState([]); // array of { dataUrl, sharpness }
  const [pendingShot, setPendingShot] = useState(null); // shot awaiting accept/retake
  const [submitting, setSubmitting] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState(0);
  const [analysisMessage, setAnalysisMessage] = useState('');
  const [analysisPreview, setAnalysisPreview] = useState(null);
  const [analysisPreviewStage, setAnalysisPreviewStage] = useState('original');
  const [recentScansOpen, setRecentScansOpen] = useState(false);
  const [recentScans, setRecentScans] = useState([]);

  function analysisStatus(message) {
    const messages = {
      'Loading the offline model': t('analysis_loading_model'),
      'Preparing the leaf image': t('analysis_preparing_image'),
      'Reading leaf features': t('analysis_reading_features'),
      'Checking the model result': t('analysis_checking_result'),
      'Analysis complete': t('analysis_complete'),
    };
    return messages[message] || message;
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return;

    video.srcObject = stream;
    video.play().catch(() => {
      setCameraError(t('camera_denied'));
    });

    return () => {
      video.pause();
      video.srcObject = null;
    };
  }, [stream, t]);

  useEffect(() => {
    if (recentScansOpen) getRecentPredictions(5).then(setRecentScans);
  }, [recentScansOpen]);

  async function startCamera() {
    setCameraError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      setCameraReady(false);
      setStream(s);
    } catch (err) {
      setCameraError(t('camera_denied'));
    }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }
    setCameraReady(false);
  }

  function capturePhoto() {
    const video = videoRef.current;
    if (!video || !cameraReady || video.videoWidth === 0 || video.videoHeight === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const sharpness = estimateSharpness(canvas);
    stopCamera();
    setPendingShot({ dataUrl, sharpness, isBlurry: sharpness < BLUR_VARIANCE_THRESHOLD });
  }

  function selectFromGallery() {
    galleryInputRef.current?.click();
  }

  function handleGalleryImage(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const sharpness = estimateSharpness(canvas);
        setPendingShot({ dataUrl, sharpness, isBlurry: sharpness < BLUR_VARIANCE_THRESHOLD });
      };
      image.onerror = () => setCameraError(t('gallery_invalid'));
      image.src = reader.result;
    };
    reader.onerror = () => setCameraError(t('gallery_invalid'));
    reader.readAsDataURL(file);
  }

  function acceptShot() {
    const next = [...shots, pendingShot];
    setPendingShot(null);
    setShots(next);
    if (next.length < TOTAL_SHOTS) {
      startCamera();
    }
  }

  function retakeShot() {
    setPendingShot(null);
    startCamera();
  }

  async function finalizeShots(allShots) {
    setSubmitting(true);
    setAnalysisProgress(5);
    setAnalysisMessage(t('analysis_loading_model'));
    setAnalysisPreview(allShots[0].dataUrl);
    setAnalysisPreviewStage('original');
    const record = await savePrediction({
      image: allShots[0].dataUrl,
      shotCount: allShots.length,
      diseaseLabel: null,
      confidence: null,
    });

    try {
      const result = await predictDiseaseOffline(allShots.map((shot) => shot.dataUrl), (progress, message, details) => {
        setAnalysisProgress(progress);
        setAnalysisMessage(analysisStatus(message));
        if (details?.previewUrl) {
          setAnalysisPreview(details.previewUrl);
          setAnalysisPreviewStage(details.stage || 'original');
        }
      });
      await savePrediction({ ...record, ...result });
    } catch (error) {
      await savePrediction({
        ...record,
        syncStatus: 'failed',
        analysisError: error.message,
      });
      setCameraError(error.message);
      setSubmitting(false);
      setAnalysisPreview(null);
      return;
    }

    setSubmitting(false);
    navigate('/result');
  }

  function reset() {
    setShots([]);
    setPendingShot(null);
    stopCamera();
  }

  const progressLabel = t('shot_progress', { current: Math.min(shots.length + 1, TOTAL_SHOTS), total: TOTAL_SHOTS });
  const viewpoint = ['front', 'left', 'right'][Math.min(shots.length, TOTAL_SHOTS - 1)];
  const viewpointLabel = t('viewpoint_instruction', { view: t(`view_${viewpoint}`) });

  return (
    <div className="page page-enter">
      <h1>{t('scan_title')}</h1>
      <p className="page-subtitle">{t('scan_subtitle')}</p>
      <div className="capture-instruction" role="status">
        <Icon name="eye" size={20} />
        <span>{viewpointLabel}</span>
      </div>

      <button
        className="scan-history-toggle"
        type="button"
        aria-expanded={recentScansOpen}
        onClick={() => setRecentScansOpen((open) => !open)}
      >
        <span><Icon name="clock" size={17} /> {t('recent_scans')}</span>
        <Icon name={recentScansOpen ? 'plus' : 'plus'} size={17} className={recentScansOpen ? 'rotate-45' : ''} />
      </button>

      {recentScansOpen && (
        <div className="scan-history card">
          {recentScans.length === 0 && (
            <div className="empty-state">
              <Icon name="leaf" className="empty-icon" size={34} />
              <p>{t('no_scans_yet')}</p>
            </div>
          )}
          {recentScans.map((scan) => (
            <div className="list-row" key={scan.clientId}>
              <img className="list-thumb" src={scan.image} alt="" />
              <div style={{ flex: 1 }}>
                <div className="scan-history-name">{scan.diseaseLabel ? t(`disease_${scan.diseaseLabel}`, { defaultValue: scan.diseaseLabel }) : t('analysis_pending')}</div>
                <div className="scan-history-time">{formatTime(scan.createdAt)}</div>
              </div>
              <span className={`status-pill ${scan.syncStatus === 'synced' || scan.syncStatus === 'offline' ? 'status-synced' : 'status-pending'}`}>
                <Icon name={scan.syncStatus === 'synced' || scan.syncStatus === 'offline' ? 'check' : 'clock'} size={15} />
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="camera-preview">
        {stream && !pendingShot && (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            onLoadedMetadata={() => setCameraReady(true)}
          />
        )}
        {stream && !pendingShot && <div className="capture-guide" />}
        {stream && !pendingShot && <span className="shot-counter">{progressLabel}</span>}
        {pendingShot && <img src={pendingShot.dataUrl} alt="Captured leaf" />}
        {!stream && !pendingShot && shots.length > 0 && <img src={shots[shots.length - 1].dataUrl} alt="Last captured leaf" />}
      </div>

      <input
        ref={galleryInputRef}
        className="sr-only"
        type="file"
        accept="image/*"
        onChange={handleGalleryImage}
        aria-label={t('choose_gallery')}
      />

      {cameraError && <div className="quality-warning">{cameraError}</div>}

      {pendingShot?.isBlurry && (
        <div className="quality-warning">
          {t('quality_warning')}
        </div>
      )}

      {!stream && !pendingShot && shots.length === 0 && (
        <div className="capture-options">
          <button className="btn btn-primary" onClick={startCamera}>
            <Icon name="camera" size={19} /> {t('open_camera')}
          </button>
          <button className="btn btn-secondary" onClick={selectFromGallery}>
            <Icon name="image" size={19} /> {t('choose_gallery')}
          </button>
        </div>
      )}

      {stream && !pendingShot && (
        <div className="capture-options">
          <button className="btn btn-primary" onClick={capturePhoto} disabled={!cameraReady}>
            {t('capture')}
          </button>
          <button className="btn btn-secondary" onClick={() => { stopCamera(); selectFromGallery(); }}>
            <Icon name="image" size={19} /> {t('choose_gallery')}
          </button>
        </div>
      )}

      {pendingShot && (
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={retakeShot}>
            {t('retake')}
          </button>
          <button
            className={pendingShot.isBlurry ? 'btn btn-danger-outline' : 'btn btn-primary'}
            style={{ flex: 1 }}
            onClick={acceptShot}
          >
            {pendingShot.isBlurry ? t('use_anyway') : t('use_photo')}
          </button>
        </div>
      )}

      {!stream && !pendingShot && shots.length > 0 && shots.length < TOTAL_SHOTS && (
        <div className="capture-options">
          <button className="btn btn-primary" onClick={startCamera}>
            <Icon name="camera" size={19} /> {t('open_camera')}
          </button>
          <button className="btn btn-secondary" onClick={selectFromGallery}>
            <Icon name="image" size={19} /> {t('choose_gallery')}
          </button>
        </div>
      )}

      {!stream && !pendingShot && shots.length === TOTAL_SHOTS && !submitting && (
        <button className="btn btn-primary" onClick={() => finalizeShots(shots)}>
          {t('use_photo')}
        </button>
      )}

      {submitting && (
        <div className="card">
          {analysisPreview && (
            <div className="analysis-vision">
              <div className="analysis-vision-heading">
                <span>{t('analysis_model_view')}</span>
                <span className="analysis-vision-stage">
                  {analysisPreviewStage === 'model_input' ? t('analysis_model_input') : t('analysis_original_image')}
                </span>
              </div>
              <img src={analysisPreview} alt={t('analysis_model_view')} />
              <p>{t('analysis_model_view_note')}</p>
            </div>
          )}
          <span className="status-pill status-pending pulse"><Icon name="clock" size={14} /> {analysisProgress}/100%</span>
          <p style={{ marginTop: '0.6rem' }}>{analysisMessage}</p>
          <div className="confidence-track" style={{ marginTop: '0.8rem' }}>
            <div className="confidence-fill" style={{ width: `${analysisProgress}%`, background: 'var(--vine)' }} />
          </div>
        </div>
      )}

      {(shots.length > 0 || pendingShot) && !submitting && (
        <button className="btn btn-secondary" style={{ width: '100%', marginTop: '0.7rem' }} onClick={reset}>
          {t('scan_again')}
        </button>
      )}
    </div>
  )
}

export default Camera
