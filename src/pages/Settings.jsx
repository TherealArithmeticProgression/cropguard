import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { setPreference, getPreference, getPendingPredictions } from '../db/indexedDB'
import { SUPPORTED_LANGUAGES } from '../i18n'
import Icon from '../components/Icon'
import { setVoiceGuidanceEnabled, voiceSupported } from '../services/voiceGuidance'

function Settings() {
  const { t, i18n } = useTranslation();
  const [language, setLanguage] = useState(i18n.language);
  const [pendingCount, setPendingCount] = useState(0);
  const [voiceEnabled, setVoiceEnabled] = useState(false);

  useEffect(() => {
    getPreference('userLang').then((saved) => { if (saved) setLanguage(saved); });
    getPendingPredictions().then((p) => setPendingCount(p.length));
    getPreference('voiceGuidance').then((enabled) => setVoiceEnabled(enabled === true));
  }, []);

  async function selectLanguage(code) {
    setLanguage(code);
    // Previously this only updated local component state and did nothing
    // else -- the switcher looked functional but silently changed nothing.
    await i18n.changeLanguage(code);
    await setPreference('userLang', code);
  }

  async function toggleVoice() {
    const next = !voiceEnabled;
    setVoiceEnabled(next);
    await setVoiceGuidanceEnabled(next);
  }

  return (
    <div className="page page-enter">
      <h1>{t('settings_title')}</h1>
      <p className="page-subtitle">{t('settings_subtitle')}</p>

      <div className="card">
        <div className="card-label">{t('language')}</div>
        {SUPPORTED_LANGUAGES.map((lang) => (
          <button key={lang.code} type="button" className="option-row" onClick={() => selectLanguage(lang.code)}>
            <span>{lang.label}</span>
            {language === lang.code && <Icon name="check" size={18} />}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="option-row option-row-static">
          <span>{t('voice_guidance')}</span>
          <button className={`toggle-button ${voiceEnabled ? 'is-on' : ''}`} type="button" role="switch" aria-checked={voiceEnabled} disabled={!voiceSupported()} onClick={toggleVoice}>
            {voiceEnabled ? t('on') : t('off')}
          </button>
        </div>
        {!voiceSupported() && <p className="settings-note">{t('voice_not_supported')}</p>}
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
