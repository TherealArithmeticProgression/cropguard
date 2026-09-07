import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { addSensorData, setPreference } from './db/indexedDB'
import Home from './pages/Home'
import Camera from './pages/Camera'
import RiskScore from './pages/RiskScore'
import Result from './pages/Result'
import Settings from './pages/Settings'
import Login from './pages/Login'
import { useTranslation } from 'react-i18next'
import Icon from './components/Icon'

function App() {
  const { t, i18n } = useTranslation();
  // An offline-first app that never tells the farmer whether it's actually
  // online is hiding the one piece of state that most affects what they
  // should expect from it -- this was entirely missing before.
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  async function selectLanguage(event) {
    const language = event.target.value;
    await i18n.changeLanguage(language);
    await setPreference('userLang', language);
  }

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  useEffect(() => {
    // Global function for sensor integration -- contract unchanged.
    window.receiveSensorData = async (data) => {
      const allowed = ['temperature', 'humidity', 'soil_moisture', 'rainfall_mm'];
      const reading = Object.fromEntries(allowed.filter((key) => Number.isFinite(Number(data?.[key]))).map((key) => [key, Number(data[key])]));
      if (!Object.keys(reading).length) throw new TypeError('Sensor payload needs numeric telemetry values.');
      if (reading.humidity != null && (reading.humidity < 0 || reading.humidity > 100)) throw new RangeError('Humidity must be a percentage between 0 and 100.');
      if (reading.soil_moisture != null && (reading.soil_moisture < 0 || reading.soil_moisture > 100)) throw new RangeError('Soil moisture must be a percentage between 0 and 100.');
      if (reading.rainfall_mm != null && reading.rainfall_mm < 0) throw new RangeError('Rainfall cannot be negative.');
      if (data?.recorded_at) reading.recorded_at = new Date(data.recorded_at).toISOString();
      await addSensorData(reading);
      window.dispatchEvent(new CustomEvent('sensorDataUpdated', { detail: reading }));
    };
    return () => { delete window.receiveSensorData; };
  }, []);

  return (
    <BrowserRouter>
      <div className="app-shell">
        <div className="topbar">
          <div className="topbar-title"><Icon name="brand" size={25} /> {t('brand_name')}</div>
          <div className="topbar-actions">
            <label className="language-control">
              <span className="sr-only">{t('language')}</span>
              <select value={i18n.language} onChange={selectLanguage} aria-label={t('language')}>
                <option value="en">EN</option>
                <option value="hi">हि</option>
                <option value="pa">ਪੰ</option>
                <option value="bn">বা</option>
                <option value="ta">த</option>
              </select>
            </label>
            <span className="offline-pill">{isOnline ? t('online') : t('offline')}</span>
          </div>
        </div>

        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Home />} />
          <Route path="/camera" element={<Camera />} />
          <Route path="/risk-score" element={<RiskScore />} />
          <Route path="/result" element={<Result />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>

        <nav className="bottom-nav">
          <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Icon name="home" className="nav-icon" />{t('home')}
          </NavLink>
          <NavLink to="/camera" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Icon name="scan" className="nav-icon" />{t('scan')}
          </NavLink>
          <NavLink to="/risk-score" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Icon name="risk" className="nav-icon" />{t('risk')}
          </NavLink>
          <NavLink to="/result" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Icon name="result" className="nav-icon" />{t('result')}
          </NavLink>
          <NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
            <Icon name="settings" className="nav-icon" />{t('settings')}
          </NavLink>
        </nav>
      </div>
    </BrowserRouter>
  )
}

export default App
