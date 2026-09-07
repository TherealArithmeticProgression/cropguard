import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { setPreference } from '../db/indexedDB';
import { requestOtp, verifyOtp } from '../services/api';
import { SUPPORTED_LANGUAGES } from '../i18n';
import Icon from '../components/Icon';

export default function Login() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [phoneNumber, setPhoneNumber] = useState('');
  const [otp, setOtp] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [activeField, setActiveField] = useState('phone');
  const [lang, setLang] = useState('hi');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [otpSent, setOtpSent] = useState(false);

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = SpeechRecognition ? new SpeechRecognition() : null;

  useEffect(() => {
    i18n.changeLanguage(lang);
  }, [lang, i18n]);

  const handleListen = (field) => {
    if (!recognition) {
      setMessage(t('camera_denied')); // reused generic "not supported" phrasing
      return;
    }
    setActiveField(field);
    setIsListening(true);

    const langMap = { hi: 'hi-IN', pa: 'pa-IN', bn: 'bn-IN', ta: 'ta-IN', en: 'en-IN' };
    recognition.lang = langMap[lang] || 'hi-IN';
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      const digits = transcript.replace(/[^0-9]/g, '');
      if (digits) {
        if (field === 'phone') setPhoneNumber((prev) => prev + digits);
        else setOtp((prev) => prev + digits);
      }
      setIsListening(false);
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognition.start();
  };

  const handleRequestOtp = async () => {
    setBusy(true);
    setMessage('');
    try {
      const result = await requestOtp(phoneNumber);
      setMessage(result.detail || 'Verification code sent.');
      setOtpSent(true);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async () => {
    setBusy(true);
    try {
      await verifyOtp(phoneNumber, otp, lang);
      await setPreference('userPhone', phoneNumber);
      await setPreference('userLang', lang);
      navigate('/');
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page page-enter" style={{ paddingBottom: '2rem' }}>
      <h1>{t('login_title')}</h1>
      <p className="page-subtitle">{t('select_language')}</p>

      <div className="card">
        <div className="card-label">{t('language')}</div>
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value)}
          style={{ width: '100%', padding: '0.75rem', borderRadius: '10px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--ink)', fontSize: '1rem' }}
        >
          {SUPPORTED_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
      </div>

      {lang === 'pa' && (
        <div className="quality-warning">{t('punjabi_warning')}</div>
      )}

      <div className="card">
        <div className="card-label">{t('phone_number')}</div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            type="tel" inputMode="tel" autoComplete="tel" placeholder="+91 98765 43210"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            style={{ flex: 1, padding: '0.75rem', borderRadius: '10px', border: '1px solid var(--border)', fontSize: '1rem' }}
          />
          <button
            className="btn-icon"
            onClick={() => handleListen('phone')}
            aria-label={t('start_voice')}
            style={isListening && activeField === 'phone' ? { background: 'var(--tomato-soft)', color: 'var(--tomato)' } : undefined}
          >
            <Icon name="microphone" size={20} />
          </button>
        </div>
        <button
          className="btn btn-primary"
          disabled={busy || !phoneNumber}
          onClick={handleRequestOtp}
          style={{ marginTop: '0.7rem' }}
        >
          {busy ? t('requesting_otp') : t('request_otp')}
        </button>
      </div>

      {otpSent && (
        <div className="card">
          <div className="card-label">{t('otp')}</div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="text" inputMode="numeric" autoComplete="one-time-code" maxLength="6"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
              style={{ flex: 1, padding: '0.75rem', borderRadius: '10px', border: '1px solid var(--border)', fontSize: '1rem', letterSpacing: '0.2em' }}
            />
            <button
              className="btn-icon"
              onClick={() => handleListen('otp')}
              aria-label={t('start_voice')}
              style={isListening && activeField === 'otp' ? { background: 'var(--tomato-soft)', color: 'var(--tomato)' } : undefined}
            >
              <Icon name="microphone" size={20} />
            </button>
          </div>
        </div>
      )}

      {message && <p role="status" style={{ color: 'var(--ink-muted)', fontSize: '0.9rem', margin: '0.5rem 0' }}>{message}</p>}

      {otpSent && (
        <button className="btn btn-primary" disabled={busy || otp.length < 4} onClick={handleLogin}>
          {t('submit')}
        </button>
      )}
    </div>
  );
}
