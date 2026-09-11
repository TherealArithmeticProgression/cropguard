import { openDB } from 'idb';

const DB_NAME = 'cropguard-db';
const DB_VERSION = 3;

export async function initDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('preferences')) {
        db.createObjectStore('preferences');
      }
      if (!db.objectStoreNames.contains('sensorData')) {
        db.createObjectStore('sensorData', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('outbreaks')) {
        db.createObjectStore('outbreaks', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('predictions')) {
        const predictions = db.createObjectStore('predictions', { keyPath: 'clientId' });
        predictions.createIndex('by-created-at', 'createdAt');
        predictions.createIndex('by-sync-status', 'syncStatus');
      }
      // New in this pass: cached multi-disease risk scores, so the Risk page
      // has something real to show offline instead of a hardcoded number.
      if (!db.objectStoreNames.contains('riskScores')) {
        db.createObjectStore('riskScores', { keyPath: 'disease' });
      }
      if (!db.objectStoreNames.contains('presentationScenarios')) {
        db.createObjectStore('presentationScenarios', { keyPath: 'id' });
      }
    },
  });
}

// --- Existing exports, unchanged signatures ---

export async function setPreference(key, value) {
  const db = await initDB();
  return db.put('preferences', value, key);
}

export async function getPreference(key) {
  const db = await initDB();
  return db.get('preferences', key);
}

export async function addSensorData(data) {
  const db = await initDB();
  return db.add('sensorData', { ...data, timestamp: new Date().toISOString() });
}

export async function savePrediction(prediction) {
  const db = await initDB();
  // clientId is required by the keyPath -- generate one if the caller didn't
  // supply it, so every save is guaranteed to work and dedupe correctly on sync.
  const record = {
    clientId: prediction.clientId || `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: prediction.createdAt || new Date().toISOString(),
    syncStatus: prediction.syncStatus || 'pending',
    ...prediction,
  };
  await db.put('predictions', record);
  return record;
}

export async function getRecentPredictions(limit = 5) {
  const db = await initDB();
  const all = await db.getAll('predictions');
  return all.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, limit);
}

export async function getLatestSensorData() {
  const db = await initDB();
  const all = await db.getAll('sensorData');
  return all.length > 0 ? all[all.length - 1] : null;
}

// --- New exports (additive only -- nothing above was renamed or removed) ---

export async function getPendingPredictions() {
  const db = await initDB();
  const all = await db.getAll('predictions');
  return all.filter((p) => p.syncStatus === 'pending');
}

export async function markPredictionSynced(clientId, serverResult = {}) {
  const db = await initDB();
  const existing = await db.get('predictions', clientId);
  if (!existing) return null;
  const updated = { ...existing, ...serverResult, syncStatus: 'synced' };
  await db.put('predictions', updated);
  return updated;
}

export async function saveRiskScores(riskResults) {
  // riskResults: array of { disease, score, band, explanation, updatedAt }
  const db = await initDB();
  const tx = db.transaction('riskScores', 'readwrite');
  await Promise.all(riskResults.map((r) => tx.store.put({ ...r, updatedAt: r.updatedAt || new Date().toISOString() })));
  await tx.done;
  return riskResults;
}

export async function getCachedRiskScores() {
  const db = await initDB();
  return db.getAll('riskScores');
}

export async function savePresentationScenarios(scenarios) {
  const db = await initDB();
  const tx = db.transaction('presentationScenarios', 'readwrite');
  await tx.store.clear();
  await Promise.all(scenarios.map((scenario) => tx.store.put(scenario)));
  await tx.done;
  return scenarios;
}

export async function getPresentationScenarios() {
  const db = await initDB();
  return db.getAll('presentationScenarios');
}

export async function clearPresentationData() {
  const db = await initDB();
  const tx = db.transaction(['presentationScenarios', 'riskScores'], 'readwrite');
  await tx.objectStore('presentationScenarios').clear();
  await tx.objectStore('riskScores').clear();
  await tx.done;
}
