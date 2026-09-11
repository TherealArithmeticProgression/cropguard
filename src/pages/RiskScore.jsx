import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCachedRiskScores, saveRiskScores, addSensorData, getPreference, getPresentationScenarios } from '../db/indexedDB';
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
  const [presentationScenarios, setPresentationScenarios] = useState([]);

  useEffect(() => {
    async function load() {
      const cached = await getCachedRiskScores();
      setRiskScores(cached);
      const presentationMode = await getPreference('presentationMode');
      if (presentationMode) setPresentationScenarios(await getPresentationScenarios());
      try {
        if (presentationMode) return;
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

  return (
    <div className="page page-enter">
      <h1>{t('risk_title')}</h1>
      <p className="page-subtitle">{t('risk_subtitle')}</p>

      {presentationScenarios.length > 0 && (
        <div className="card presentation-table-card">
          <div className="card-label">{t('presentation_readings')}</div>
          <div className="presentation-table-wrap">
            <table className="presentation-table">
              <thead><tr><th>{t('condition')}</th><th>{t('sensor_temp')}</th><th>{t('sensor_humidity')}</th><th>{t('sensor_moisture')}</th><th>{t('risk')}</th></tr></thead>
              <tbody>{presentationScenarios.map((scenario) => <tr key={scenario.id}>
                <td>{t(`condition_${scenario.id}`, { defaultValue: scenario.id })}</td><td>{scenario.temperature}°C</td><td>{scenario.humidity}%</td><td>{scenario.soilMoisture}%</td><td><strong>{scenario.topScore}/100</strong><br /><small>{t(`disease_${scenario.topDisease}`, { defaultValue: scenario.topDisease })}</small></td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>
      )}

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
