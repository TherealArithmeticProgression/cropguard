import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getRecentPredictions, getPendingPredictions, getCachedRiskScores } from '../db/indexedDB'
import Icon from '../components/Icon'

const BAND_ORDER = { low: 0, moderate: 1, high: 2, critical: 3 };

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
}

function Home() {
  const { t } = useTranslation();
  const [scans, setScans] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [topRisk, setTopRisk] = useState(null); // { disease, score, band }
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [recent, pending, riskScores] = await Promise.all([
        getRecentPredictions(5),
        getPendingPredictions(),
        getCachedRiskScores(),
      ]);
      if (cancelled) return;

      setScans(recent);
      setPendingCount(pending.length);

      if (riskScores.length > 0) {
        const worst = riskScores.reduce((a, b) =>
          (BAND_ORDER[b.band] ?? 0) > (BAND_ORDER[a.band] ?? 0) ? b : a
        );
        setTopRisk(worst);
      }
      setLoading(false);
    }

    load();
    // Sensor readings can update risk in the background -- refresh when they do.
    window.addEventListener('sensorDataUpdated', load);
    return () => { cancelled = true; window.removeEventListener('sensorDataUpdated', load); };
  }, []);

  const bandClass = topRisk ? `level-${topRisk.band}` : 'level-low';
  const bandIcon = { low: 'check', moderate: 'eye', high: 'alert', critical: 'alert' }[topRisk?.band] || 'check';

  return (
    <div className="page page-enter">
      <h1>{t('home_title')}</h1>
      <p className="page-subtitle">{t('home_subtitle')}</p>

      <div className={`alert-banner ${bandClass}`}>
        <Icon name={bandIcon} className="alert-icon" size={22} />
        <div>
          <div className="alert-title">
            {topRisk && BAND_ORDER[topRisk.band] >= 2
              ? `${topRisk.disease} — ${topRisk.band}`
              : t('all_clear_title')}
          </div>
          <div className="alert-body">
            {topRisk ? topRisk.explanation : t('all_clear_body')}
          </div>
        </div>
      </div>

      {pendingCount > 0 && (
        <div className="card">
          <div className="card-label">{t('recent_scans')}</div>
          <span className="status-pill status-pending pulse">
            <Icon name="clock" size={15} /> {pendingCount === 1 ? t('pending_sync_one') : t('pending_sync_many', { count: pendingCount })}
          </span>
        </div>
      )}

      <div className="card">
        <div className="card-label">{t('recent_scans')}</div>

        {loading && <p style={{ color: 'var(--ink-muted)' }}>…</p>}

        {!loading && scans.length === 0 && (
          <div className="empty-state">
            <Icon name="leaf" className="empty-icon" size={34} />
            <p>{t('no_scans_yet')}</p>
          </div>
        )}

        {!loading && scans.map((scan) => (
          <div className="list-row" key={scan.clientId}>
            <img className="list-thumb" src={scan.image} alt="" />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '0.9rem' }}>{scan.diseaseLabel || t('analysis_pending')}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>{formatTime(scan.createdAt)}</div>
            </div>
            <span className={`status-pill ${scan.syncStatus === 'synced' || scan.syncStatus === 'offline' ? 'status-synced' : 'status-pending'}`}>
              <Icon name={scan.syncStatus === 'synced' ? 'check' : 'clock'} size={15} />
            </span>
          </div>
        ))}
      </div>

      {!loading && scans.length === 0 && (
        <Link to="/camera" className="btn btn-primary" style={{ textDecoration: 'none' }}>
          <Icon name="camera" size={19} /> {t('first_scan_cta')}
        </Link>
      )}
    </div>
  )
}

export default Home
