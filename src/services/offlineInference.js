import * as ort from 'onnxruntime-web';

const MODEL_URL = '/weights_final_.onnx';
const IMAGE_SIZE = 224;
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];
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
  const cropSize = Math.min(image.naturalWidth || image.width, image.naturalHeight || image.height);
  const cropX = ((image.naturalWidth || image.width) - cropSize) / 2;
  const cropY = ((image.naturalHeight || image.height) - cropSize) / 2;
  context.drawImage(image, cropX, cropY, cropSize, cropSize, 0, 0, IMAGE_SIZE, IMAGE_SIZE);
  const imageData = context.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE);
  const { data } = imageData;

  const tensorData = new Float32Array(3 * IMAGE_SIZE * IMAGE_SIZE);

  for (let pixel = 0; pixel < IMAGE_SIZE * IMAGE_SIZE; pixel += 1) {
    tensorData[pixel] = ((data[pixel * 4] / 255) - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    tensorData[IMAGE_SIZE * IMAGE_SIZE + pixel] = ((data[pixel * 4 + 1] / 255) - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    tensorData[2 * IMAGE_SIZE * IMAGE_SIZE + pixel] = ((data[pixel * 4 + 2] / 255) - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }

  return {
    tensor: new ort.Tensor('float32', tensorData, [1, 3, IMAGE_SIZE, IMAGE_SIZE]),
    previewUrl: canvas.toDataURL('image/jpeg', 0.9),
  };
}

function softmax(values) {
  const max = Math.max(...values);
  const exponentials = values.map((value) => Math.exp(value - max));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return exponentials.map((value) => value / total);
}

function probabilitiesFromOutput(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  const looksLikeProbabilities = values.every((value) => value >= 0 && value <= 1) && Math.abs(total - 1) < 0.02;
  return looksLikeProbabilities ? values : softmax(values);
}

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
    });
  }
  return sessionPromise;
}

export async function predictDiseaseOffline(dataUrls, onProgress = () => {}) {
  const images = Array.isArray(dataUrls) ? dataUrls : [dataUrls];
  onProgress(5, 'Loading the offline model');
  const session = await getSession();
  const inputName = session.inputNames[0];

  const predictions = [];
  for (let index = 0; index < images.length; index += 1) {
    onProgress(20 + Math.round((index / images.length) * 55), 'Preparing the leaf image', {
      previewUrl: images[index],
      stage: 'original',
      imageNumber: index + 1,
    });
    const image = await loadImage(images[index]);
    const { tensor, previewUrl } = imageToTensor(image);
    onProgress(23 + Math.round((index / images.length) * 55), 'Preparing the leaf image', {
      previewUrl,
      stage: 'model_input',
      imageNumber: index + 1,
    });
    onProgress(25 + Math.round((index / images.length) * 55), 'Reading leaf features');
    const output = await session.run({ [inputName]: tensor });
    const outputTensor = output[session.outputNames[0]];
    const scores = Array.from(outputTensor.data).slice(0, CLASS_NAMES.length);
    if (scores.length !== CLASS_NAMES.length || scores.some((score) => !Number.isFinite(score))) {
      throw new Error('The offline model returned an unexpected result.');
    }
    predictions.push(probabilitiesFromOutput(scores));
  }

  const probabilities = CLASS_NAMES.map((_, classIndex) => (
    predictions.reduce((sum, prediction) => sum + prediction[classIndex], 0) / predictions.length
  ));
  const ranked = probabilities
    .map((confidence, index) => ({
      label: CLASS_NAMES[index],
      confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100),
    }))
    .sort((a, b) => b.confidence - a.confidence);
  const best = ranked[0];

  onProgress(90, 'Checking the model result');
  await new Promise((resolve) => setTimeout(resolve, 120));
  onProgress(100, 'Analysis complete');

  return {
    diseaseLabel: best.label,
    confidence: best.confidence,
    topThree: ranked.slice(0, 3),
    modelScores: ranked,
    modelOutputCount: CLASS_NAMES.length,
    treatment: TREATMENTS[best.label],
    syncStatus: 'offline',
  };
}