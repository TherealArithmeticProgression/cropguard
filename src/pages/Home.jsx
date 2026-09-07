import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getCachedRiskScores } from '../db/indexedDB'
import Icon from '../components/Icon'

const BAND_ORDER = { low: 0, moderate: 1, high: 2, critical: 3 };

function Home() {
  const { t } = useTranslation();
  const [topRisk, setTopRisk] = useState(null); // { disease, score, band }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const riskScores = await getCachedRiskScores();
      if (cancelled) return;

      if (riskScores.length > 0) {
        const worst = riskScores.reduce((a, b) =>
          (BAND_ORDER[b.band] ?? 0) > (BAND_ORDER[a.band] ?? 0) ? b : a
        );
        setTopRisk(worst);
      }
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
              ? `${t(`disease_${topRisk.disease}`, { defaultValue: topRisk.disease })} — ${topRisk.band}`
              : t('all_clear_title')}
          </div>
          <div className="alert-body">
            {topRisk ? topRisk.explanation : t('all_clear_body')}
          </div>
        </div>
      </div>

    </div>
  )
}

export default Home
