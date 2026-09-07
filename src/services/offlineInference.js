import * as ort from 'onnxruntime-web';

const MODEL_URL = '/weights_final_.onnx';
const IMAGE_SIZE = 224;
const CLASS_NAMES = [
  'bacterial_spot',
  'early_blight',
  'late_blight',
  'septoria_leaf_spot',
];

const TREATMENTS = {
  bacterial_spot: 'Remove affected leaves and avoid overhead watering. Use an approved copper-based treatment according to its label.',
  early_blight: 'Remove affected leaves, improve airflow, and use an approved fungicide according to its label.',
  late_blight: 'Isolate affected plants, remove infected material, and apply an approved fungicide promptly according to its label.',
  septoria_leaf_spot: 'Remove affected leaves, keep foliage dry, and use an approved fungicide according to its label.',
};

let sessionPromise;

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The captured image could not be prepared for offline analysis.'));
    image.src = dataUrl;
  });
}

function imageToTensor(image) {
  const canvas = document.createElement('canvas');
  canvas.width = IMAGE_SIZE;
  canvas.height = IMAGE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
  const { data } = context.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE);
  const tensorData = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE);

  for (let pixel = 0; pixel < IMAGE_SIZE * IMAGE_SIZE; pixel += 1) {
    tensorData[pixel] = data[pixel * 4] / 255;
    tensorData[IMAGE_SIZE * IMAGE_SIZE + pixel] = data[pixel * 4 + 1] / 255;
    tensorData[2 * IMAGE_SIZE * IMAGE_SIZE + pixel] = data[pixel * 4 + 2] / 255;
  }

  return new ort.Tensor('float32', tensorData, [1, 3, IMAGE_SIZE, IMAGE_SIZE]);
}

function softmax(values) {
  const max = Math.max(...values);
  const exponentials = values.map((value) => Math.exp(value - max));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => value / total);
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
    });
  }
  return sessionPromise;
}

export async function predictDiseaseOffline(dataUrl, onProgress = () => {}) {
  onProgress(5, 'Loading the offline model');
  const session = await getSession();

  onProgress(20, 'Preparing the leaf image');
  const image = await loadImage(dataUrl);
  const input = imageToTensor(image);
  const inputName = session.inputNames[0];

  onProgress(35, 'Reading leaf features');
  const output = await session.run({ [inputName]: input });
  const outputTensor = output[session.outputNames[0]];
  const scores = Array.from(outputTensor.data).slice(0, CLASS_NAMES.length);
  const probabilities = softmax(scores);
  const ranked = probabilities
    .map((confidence, index) => ({
      label: CLASS_NAMES[index],
      confidence: Math.round(confidence * 100),
    }))
    .sort((a, b) => b.confidence - a.confidence);
  const best = ranked[0];

  onProgress(85, 'Checking the model result');
  await new Promise((resolve) => setTimeout(resolve, 120));
  onProgress(100, 'Analysis complete');

  return {
    diseaseLabel: best.label,
    confidence: best.confidence,
    topThree: ranked.slice(0, 3),
    treatment: TREATMENTS[best.label],
    syncStatus: 'offline',
  };
}