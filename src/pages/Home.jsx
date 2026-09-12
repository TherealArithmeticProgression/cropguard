import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCachedRiskScores, getPreference } from '../db/indexedDB'
import { speak } from '../services/voiceGuidance'
import Icon from '../components/Icon'

const BAND_ORDER = { low: 0, moderate: 1, high: 2, critical: 3 };

function Home() {
  const { t, i18n } = useTranslation();
  const [topRisk, setTopRisk] = useState(null); // { disease, score, band }
  const [hasRiskData, setHasRiskData] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const riskScores = await getCachedRiskScores();
      if (cancelled) return;

      if (riskScores.length > 0) {
        setHasRiskData(true);
        const worst = riskScores.reduce((a, b) =>
          (BAND_ORDER[b.band] ?? 0) > (BAND_ORDER[a.band] ?? 0) ? b : a
        );
        setTopRisk(worst);
      }
    }

    load();
    getPreference('voiceGuidance').then((enabled) => setVoiceEnabled(enabled === true));
    // Sensor readings can update risk in the background -- refresh when they do.
    window.addEventListener('sensorDataUpdated', load);
    return () => { cancelled = true; window.removeEventListener('sensorDataUpdated', load); };
  }, []);

  const bandClass = topRisk ? `level-${topRisk.band}` : 'level-low';
  const bandIcon = { low: 'check', moderate: 'eye', high: 'alert', critical: 'alert' }[topRisk?.band] || 'check';
  const title = !hasRiskData
    ? t('risk_data_unavailable')
    : BAND_ORDER[topRisk?.band] >= 2
      ? `${t(`disease_${topRisk.disease}`, { defaultValue: topRisk.disease })} — ${t(`risk_band_${topRisk.band}`, { defaultValue: topRisk.band })}`
      : t(`risk_band_${topRisk.band}`, { defaultValue: t('all_clear_title') });
  const explanation = !hasRiskData
    ? t('risk_data_unavailable_body')
    : t(`risk_explanation_${topRisk.disease}`, { defaultValue: topRisk.explanation });

  function readRisk() {
    speak(`${title}. ${explanation}`, i18n.language);
  }

  return (
    <div className="page page-enter">
      <h1>{t('home_title')}</h1>
      <p className="page-subtitle">{t('home_subtitle')}</p>

      <div className={`alert-banner ${bandClass}`}>
        <Icon name={bandIcon} className="alert-icon" size={22} />
        <div>
          <div className="alert-title">
            {title}
          </div>
          <div className="alert-body">{detailsOpen ? explanation : t('risk_expand_hint')}</div>
          <button className="text-button" type="button" onClick={() => setDetailsOpen((open) => !open)}>
            {detailsOpen ? t('risk_show_less') : t('risk_show_more')}
          </button>
          {voiceEnabled && <button className="btn-icon" type="button" onClick={readRisk} aria-label={t('read_aloud')}><Icon name="microphone" size={18} /></button>}
        </div>
      </div>

    </div>
  )
}

export default Home
