import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { setPreference, getPreference, getPendingPredictions } from '../db/indexedDB'
import { SUPPORTED_LANGUAGES } from '../i18n'
import Icon from '../components/Icon'

function Settings() {
  const { t, i18n } = useTranslation();
  const [language, setLanguage] = useState(i18n.language);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    getPreference('userLang').then((saved) => { if (saved) setLanguage(saved); });
    getPendingPredictions().then((p) => setPendingCount(p.length));
  }, []);

  async function selectLanguage(code) {
    setLanguage(code);
    // Previously this only updated local component state and did nothing
    // else -- the switcher looked functional but silently changed nothing.
    await i18n.changeLanguage(code);
    await setPreference('userLang', code);
  }

  return (
    <div className="page page-enter">
      <h1>{t('settings_title')}</h1>
      <p className="page-subtitle">{t('settings_subtitle')}</p>

      <div className="card">
        <div className="card-label">{t('language')}</div>
        {SUPPORTED_LANGUAGES.map((lang) => (
          <div key={lang.code} className="option-row" onClick={() => selectLanguage(lang.code)}>
            <span>{lang.label}</span>
            {language === lang.code && <Icon name="check" size={18} />}
          </div>
        ))}
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
        <div className="card-label">{t('farm_info')}</div>
        <p style={{ color: 'var(--ink-muted)', fontSize: '0.9rem' }}>{t('farm_info_placeholder')}</p>
      </div>

      <div className="card">
        <div className="card-label">{t('about')}</div>
        <p style={{ color: 'var(--ink-muted)', fontSize: '0.9rem' }}>{t('about_body')}</p>
      </div>
    </div>
  )
}

export default Settings
