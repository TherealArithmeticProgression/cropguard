import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCachedRiskScores, saveRiskScores, addSensorData, getPreference } from '../db/indexedDB';
import { fetchRiskScores } from '../services/api';
import Icon from '../components/Icon';

// Preserved exactly -- must match the ESP32 firmware's advertised service.
const SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';

const BAND_COLOR = {
  low: 'var(--leaf)',
  moderate: 'var(--turmeric)',
  high: 'var(--tomato)',
  critical: 'var(--tomato)',
};

const DEMO_SCENARIOS = {
  cool_wet: {
    temperature: '19', humidity: '92', moisture: '84',
    risks: [
      { disease: 'late_blight', score: 86, band: 'critical', explanation: 'Example only: cool temperature, high humidity, and wet conditions are favorable for late blight.' },
      { disease: 'septoria_leaf_spot', score: 72, band: 'high', explanation: 'Example only: several wet days can increase Septoria risk.' },
      { disease: 'early_blight', score: 38, band: 'moderate', explanation: 'Example only: the temperature is below the strongest early-blight range.' },
      { disease: 'bacterial_spot', score: 44, band: 'moderate', explanation: 'Example only: warm, wet splash events would increase this risk.' },
    ],
  },
  hot_dry: {
    temperature: '31', humidity: '48', moisture: '32',
    risks: [
      { disease: 'late_blight', score: 8, band: 'low', explanation: 'Example only: hot, dry conditions are less favorable for late blight.' },
      { disease: 'septoria_leaf_spot', score: 12, band: 'low', explanation: 'Example only: low humidity and little wetness reduce Septoria risk.' },
      { disease: 'early_blight', score: 42, band: 'moderate', explanation: 'Example only: warm conditions can still support early blight if plants are stressed.' },
      { disease: 'bacterial_spot', score: 18, band: 'low', explanation: 'Example only: without rain or splash events, bacterial spot risk is lower.' },
    ],
  },
};

/**
 * A single reading cannot reproduce the backend's rolling-window score. These
 * provisional per-disease values use the same environmental bands as the
 * backend and are replaced by the full score after sync.
 */
function quickLocalEstimates(temp, humidity) {
  const score = (tempFactor, humidityFactor) => Math.round(tempFactor * humidityFactor * 100);
  const above = (value, threshold, maximum) => Math.max(0, Math.min(1, (value - threshold) / (maximum - threshold)));
  const trapezoid = (value, low, optimalLow, optimalHigh, high) => {
    if (value <= low || value >= high) return 0;
    if (value >= optimalLow && value <= optimalHigh) return 1;
    return value < optimalLow
      ? (value - low) / (optimalLow - low)
      : (high - value) / (high - optimalHigh);
  };
  return [
    { disease: 'late_blight', score: score(trapezoid(temp, 6, 15, 22, 27), above(humidity, 85, 97)) },
    { disease: 'early_blight', score: score(trapezoid(temp, 15, 24, 29, 34), above(humidity, 80, 95)) },
    { disease: 'septoria_leaf_spot', score: score(trapezoid(temp, 12, 20, 25, 30), above(humidity, 85, 100)) },
    { disease: 'bacterial_leaf_spot', score: score(trapezoid(temp, 18, 24, 30, 35), above(humidity, 80, 95)) },
  ];
}

function RiskScore() {
  const { t } = useTranslation();
  const [riskScores, setRiskScores] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [temperature, setTemperature] = useState(null);
  const [humidity, setHumidity] = useState(null);
  const [moisture, setMoisture] = useState(null);
  const [statusText, setStatusText] = useState('');
  const [localEstimate, setLocalEstimate] = useState(null);
  const [demoScenario, setDemoScenario] = useState(null);

  useEffect(() => {
    async function load() {
      const cached = await getCachedRiskScores();
      setRiskScores(cached);
      try {
        const farmId = (await getPreference('farmId')) || 'default';
        const fresh = await fetchRiskScores(farmId);
        setRiskScores(fresh);
        await saveRiskScores(fresh);
      } catch {
        // Offline -- cached scores above are what we show.
      }
    }
    load();
  }, []);

  const connectToNode = async () => {
    try {
      setStatusText(t('connecting'));
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [SERVICE_UUID],
      });
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      const characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
      const value = await characteristic.readValue();

      // NOTE: firmware currently sends comma-separated plaintext
      // ("temp,humidity,moisture"). The wider hardware plan calls for CBOR --
      // swap the decode below for a CBOR decoder once the firmware ships that.
      const decoder = new TextDecoder('utf-8');
      const [t1, h1, m1] = decoder.decode(value).split(',');
      const t2 = parseFloat(t1), h2 = parseFloat(h1);

      setTemperature(t1);
      setHumidity(h1);
      setMoisture(m1);
      setStatusText('');

      if (Number.isFinite(t2) && Number.isFinite(h2)) {
        setLocalEstimate(quickLocalEstimates(t2, h2));
        await addSensorData({ temperature: t2, humidity: h2, soil_moisture: parseFloat(m1) || null });
        window.dispatchEvent(new CustomEvent('sensorDataUpdated'));
      }

      if (device.gatt.connected) device.gatt.disconnect();
    } catch (error) {
      setStatusText(t('camera_denied')); // reused generic "permission/connection failed" copy
    }
  };

  function showDemo(scenario) {
    const selected = DEMO_SCENARIOS[scenario];
    setDemoScenario(scenario);
    setRiskScores(selected.risks);
    setTemperature(selected.temperature);
    setHumidity(selected.humidity);
    setMoisture(selected.moisture);
    setStatusText('');
  }

  function clearDemo() {
    setDemoScenario(null);
    setRiskScores([]);
    setTemperature(null);
    setHumidity(null);
    setMoisture(null);
  }

  return (
    <div className="page page-enter">
      <h1>{t('risk_title')}</h1>
      <p className="page-subtitle">{t('risk_subtitle')}</p>

      <div className="demo-panel">
        <strong>{t('risk_demo_title')}</strong>
        <p>{t('risk_demo_body')}</p>
        <div className="demo-actions">
          <button className="btn btn-secondary" type="button" onClick={() => showDemo('cool_wet')}>{t('risk_demo_wet')}</button>
          <button className="btn btn-secondary" type="button" onClick={() => showDemo('hot_dry')}>{t('risk_demo_dry')}</button>
          {demoScenario && <button className="text-button" type="button" onClick={clearDemo}>{t('risk_demo_clear')}</button>}
        </div>
      </div>

      {demoScenario && <div className="demo-warning" role="status">{t('risk_demo_active')}</div>}

      {riskScores.length === 0 && (
        <div className="empty-state">
          <Icon name="sensor" className="empty-icon" size={34} />
          <p>{t('no_sensor_data')}</p>
        </div>
      )}

      {riskScores.map((r) => (
        <div key={r.disease} className="disease-row">
          <button
            className="disease-row-toggle"
            type="button"
            aria-expanded={expanded === r.disease}
            onClick={() => setExpanded(expanded === r.disease ? null : r.disease)}
          >
          <div className="disease-row-head">
            <span className="disease-name">{t(`disease_${r.disease}`, { defaultValue: r.disease })}</span>
            <span
              className="disease-score-badge"
              style={{ background: BAND_COLOR[r.band] + '22', color: BAND_COLOR[r.band] }}
            >
              {r.score}/100
            </span>
          </div>
          </button>
          {expanded === r.disease && (
            <div className="disease-why">{r.explanation}</div>
          )}
        </div>
      ))}

      <div className="card" style={{ marginTop: '1rem' }}>
        <div className="card-label">{t('connect_sensor')}</div>
        <button className="btn btn-secondary" style={{ width: '100%', marginTop: '0.5rem' }} onClick={connectToNode}>
          <Icon name="sensor" size={19} /> {t('connect_sensor')}
        </button>
        {statusText && <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--ink-muted)' }}>{statusText}</p>}

        {temperature != null && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.8rem' }}>
              <span><Icon name="thermometer" size={17} /> {t('sensor_temp')}</span><strong>{temperature}°C</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.4rem' }}>
              <span><Icon name="droplet" size={17} /> {t('sensor_humidity')}</span><strong>{humidity}%</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.4rem' }}>
              <span><Icon name="leaf" size={17} /> {t('sensor_moisture')}</span><strong>{moisture}</strong>
            </div>
            {localEstimate != null && (
              <div className="local-estimate-list">
                <p>{t('local_estimate_note')}</p>
                {localEstimate.map((estimate) => (
                  <span key={estimate.disease}>
                    {t(`disease_${estimate.disease}`, { defaultValue: estimate.disease })}: {estimate.score}/100
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default RiskScore;
