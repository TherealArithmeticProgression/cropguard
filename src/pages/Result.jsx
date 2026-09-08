import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { getRecentPredictions, savePrediction } from '../db/indexedDB'
import { submitPredictionFeedback } from '../services/api'
import { getDiseaseTreatment } from '../services/diseaseGuide'
import Icon from '../components/Icon'

// Thresholds mirror the confidence-handling design from the team's plan:
// high -> show the answer directly, medium -> show it plus alternatives,
// low -> don't assert a diagnosis at all.
function confidenceTier(confidence) {
  if (confidence == null) return 'unknown';
  if (confidence >= 75) return 'high';
  if (confidence >= 45) return 'medium';
  return 'low';
}

function Result() {
  const { t, i18n } = useTranslation();
  const [prediction, setPrediction] = useState(null);
  const [loading, setLoading] = useState(true);
  const [feedbackGiven, setFeedbackGiven] = useState(false);

  useEffect(() => {
    getRecentPredictions(1).then(([latest]) => {
      setPrediction(latest || null);
      setLoading(false);
    });
  }, []);

  async function giveFeedback(wasCorrect) {
    setFeedbackGiven(true);
    if (!prediction) return;
    try {
      await submitPredictionFeedback(prediction.clientId, wasCorrect);
    } catch {
      // Offline -- stash the feedback locally so it isn't lost; a real sync
      // pass can pick up any prediction whose feedback field is set but
      // hasn't reached the server yet.
    }
    await savePrediction({ ...prediction, feedback: wasCorrect ? 'correct' : 'incorrect' });
  }

  if (loading) return <div className="page page-enter" />;

  if (!prediction) {
    return (
      <div className="page page-enter">
        <h1>{t('result_title')}</h1>
        <div className="empty-state">
          <Icon name="result" className="empty-icon" size={34} />
          <p>{t('no_result_title')}</p>
          <p style={{ marginTop: '0.4rem' }}>{t('no_result_body')}</p>
        </div>
        <Link to="/camera" className="btn btn-primary" style={{ textDecoration: 'none', marginTop: '1rem' }}>
          {t('go_to_scan')}
        </Link>
      </div>
    );
  }

  const tier = confidenceTier(prediction.confidence);

  if (tier === 'unknown') {
    return (
      <div className="page page-enter">
        <h1>{t('result_title')}</h1>
        <div className="card">
          <span className="status-pill status-pending pulse"><Icon name="clock" size={14} /> {t('analysis_pending')}</span>
          <p style={{ marginTop: '0.6rem', color: 'var(--ink-muted)' }}>{t('saved_pending')}</p>
        </div>
      </div>
    );
  }

  const fillColor = tier === 'high' ? 'var(--leaf)' : 'var(--turmeric)';
  const localizedTreatment = getDiseaseTreatment(i18n.language, prediction.diseaseLabel) || prediction.treatment;

  return (
    <div className="page page-enter">
      <h1>{t('result_title')}</h1>
      <p className="page-subtitle">{t('result_subtitle')}</p>

      {tier === 'low' && (
        <div className="alert-banner level-moderate">
          <Icon name="search" className="alert-icon" size={22} />
          <div>
            <div className="alert-title">{t('low_confidence_title')}</div>
            <div className="alert-body">{t('low_confidence_body')}</div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-label">{t('detected_disease')}</div>
        <h2 style={{ color: 'var(--vine)', margin: '0.3rem 0' }}>
          {t(`disease_${prediction.diseaseLabel}`, { defaultValue: prediction.diseaseLabel })}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
          <div className="confidence-track">
            <div className="confidence-fill" style={{ width: `${prediction.confidence}%`, background: fillColor }} />
          </div>
          <strong style={{ fontSize: '0.9rem' }}>{prediction.confidence}%</strong>
        </div>

        {tier === 'medium' && Array.isArray(prediction.topThree) && (
          <div style={{ marginTop: '0.8rem' }}>
            <div className="card-label">{t('medium_confidence_note')}</div>
            {prediction.topThree.map((alt) => (
              <div key={alt.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', padding: '0.2rem 0' }}>
                <span>{alt.label}</span><span>{alt.confidence}%</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-label">{t('recommended_treatment')}</div>
        <p style={{ marginTop: '0.4rem' }}>{localizedTreatment}</p>
      </div>

      {!feedbackGiven ? (
        <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1rem' }}>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => giveFeedback(true)}>
            <Icon name="thumbsUp" size={18} /> {t('correct')}
          </button>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => giveFeedback(false)}>
            <Icon name="thumbsDown" size={18} /> {t('incorrect')}
          </button>
        </div>
      ) : (
        <p style={{ color: 'var(--ink-muted)', fontSize: '0.9rem', marginTop: '0.8rem' }}>{t('feedback_thanks')}</p>
      )}
    </div>
  )
}

export default Result
