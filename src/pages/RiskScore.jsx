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

/**
 * Rough, deliberately simple client-side estimate from a single instant BLE
 * reading -- NOT a replacement for the full rolling-trend risk_engine.py
 * calculation that runs server-side once data syncs. Matches the "quick local
 * estimate vs. full trend-based score" split agreed on for the BLE flow.
 */
function quickLocalEstimate(temp, humidity) {
  const tempFactor = temp >= 20 && temp <= 30 ? 1 : 0.4;
  const humidityFactor = humidity >= 80 ? 1 : humidity / 100;
  return Math.round(Math.min(tempFactor * humidityFactor * 100, 100));
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
        setLocalEstimate(quickLocalEstimate(t2, h2));
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

      {riskScores.length === 0 && (
        <div className="empty-state">
          <Icon name="sensor" className="empty-icon" size={34} />
          <p>{t('no_sensor_data')}</p>
        </div>
      )}

      {riskScores.map((r) => (
        <div key={r.disease} className="disease-row" onClick={() => setExpanded(expanded === r.disease ? null : r.disease)}>
          <div className="disease-row-head">
            <span className="disease-name">{t(`disease_${r.disease}`, { defaultValue: r.disease })}</span>
            <span
              className="disease-score-badge"
              style={{ background: BAND_COLOR[r.band] + '22', color: BAND_COLOR[r.band] }}
            >
              {r.score}/100
            </span>
          </div>
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
              <p style={{ marginTop: '0.6rem', fontSize: '0.8rem', color: 'var(--ink-muted)' }}>
                {t('local_estimate_note')} ({localEstimate}/100)
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default RiskScore;
