const path = require('path');
const sharp = require('sharp');

const MODEL_VERSION = '3.3.6';
const DEFAULT_MODEL_BASE_URL = `https://cdn.jsdelivr.net/npm/@vladmandic/human@${MODEL_VERSION}/models/`;
const MIN_FACE_SCORE = 0.65;
const MIN_MATCH_SCORE = 0.9;
const MIN_LIVE_SCORE = 0.8;
const MIN_REAL_SCORE = 0.8;
const MIN_YAW_SPREAD = 0.15;
const MAX_IMAGE_BYTES = 500_000;
const MAX_REGISTRATION_IMAGE_BYTES = 9 * 1024 * 1024;

let humanPromise = null;

function createHuman() {
  const packageEntry = require.resolve('@vladmandic/human');
  const humanPath = path.join(path.dirname(packageEntry), 'human.node-wasm.js');
  const { Human } = require(humanPath);
  const modelBasePath = String(process.env.DRIVER_FACE_MODEL_BASE_URL || DEFAULT_MODEL_BASE_URL);
  const human = new Human({
    backend: 'wasm',
    modelBasePath,
    cacheModels: false,
    face: {
      enabled: true,
      detector: { enabled: true, modelPath: 'blazeface.json', rotation: true, maxDetected: 2, minConfidence: MIN_FACE_SCORE },
      mesh: { enabled: true, modelPath: 'facemesh.json' },
      iris: { enabled: false },
      description: { enabled: true, modelPath: 'faceres.json' },
      emotion: { enabled: false },
      antispoof: { enabled: true, modelPath: 'antispoof.json' },
      liveness: { enabled: true, modelPath: 'liveness.json' }
    },
    body: { enabled: false },
    hand: { enabled: false },
    gesture: { enabled: false },
    object: { enabled: false },
    segmentation: { enabled: false }
  });
  return human;
}

async function getHuman() {
  if (!humanPromise) {
    humanPromise = (async () => {
      const human = createHuman();
      await human.tf.ready();
      await human.load();
      return human;
    })().catch(error => {
      humanPromise = null;
      throw error;
    });
  }
  return humanPromise;
}

function parseImageDataUrl(value, maxBytes = MAX_IMAGE_BYTES) {
  const match = String(value || '').match(/^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) throw new Error('Face image must be a supported base64 image.');
  const buffer = Buffer.from(match[1], 'base64');
  if (!buffer.length || buffer.length > maxBytes || buffer.toString('base64') !== match[1]) {
    throw new Error('Face image is empty or too large.');
  }
  return buffer;
}

async function readRegistrationPhoto(photo) {
  if (typeof photo !== 'string' || !photo) throw new Error('Registration photo is unavailable.');
  if (/^data:/i.test(photo)) return parseImageDataUrl(photo, MAX_REGISTRATION_IMAGE_BYTES);

  const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
  if (!configuredUrl) throw new Error('Registration photo is not locally available.');
  const base = new URL(configuredUrl);
  const target = new URL(photo, base);
  const expectedPrefix = '/storage/v1/object/public/';
  if (target.protocol !== 'https:' || target.origin !== base.origin || !target.pathname.startsWith(expectedPrefix)) {
    throw new Error('Registration photo is not in the approved media store.');
  }

  const response = await fetch(target, { redirect: 'error', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Registration photo fetch failed with HTTP ${response.status}.`);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!/^image\/(?:jpeg|jpg|png|webp)$/.test(contentType)) throw new Error('Registration photo has an unsupported format.');
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_REGISTRATION_IMAGE_BYTES) throw new Error('Registration photo is too large.');

  const reader = response.body && response.body.getReader();
  if (!reader) throw new Error('Registration photo response could not be read.');
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REGISTRATION_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error('Registration photo is too large.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function detectFace(human, imageBuffer) {
  const decoded = await sharp(imageBuffer, { limitInputPixels: 16_000_000 })
    .rotate()
    .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (decoded.info.channels !== 3 || !decoded.info.width || !decoded.info.height) {
    throw new Error('Face image could not be decoded.');
  }

  const tensor = human.tf.tensor3d(decoded.data, [decoded.info.height, decoded.info.width, 3], 'int32');
  let result;
  try {
    result = await human.detect(tensor);
    const faces = Array.isArray(result && result.face) ? result.face : [];
    return faces.map(face => ({
      embedding: Array.isArray(face.embedding) ? face.embedding.slice() : [],
      score: Number(face.faceScore || face.boxScore || 0),
      live: Number(face.live),
      real: Number(face.real),
      yaw: Number(face.rotation && face.rotation.angle && face.rotation.angle.yaw)
    }));
  } finally {
    human.tf.dispose(tensor);
    if (result && Array.isArray(result.face)) {
      result.face.forEach(face => {
        if (face.tensor) human.tf.dispose(face.tensor);
      });
    }
  }
}

async function verifyDriverFace({ registrationPhoto, selfieFrames }) {
  const frames = Array.isArray(selfieFrames) ? selfieFrames : [];
  if (frames.length !== 3) return { verified: false, reason: 'three-frame-challenge-required' };

  const frameBuffers = frames.map(parseImageDataUrl);
  const human = await getHuman();
  const recoveryFaces = [];
  for (const frame of frameBuffers) {
    const faces = await detectFace(human, frame);
    if (faces.length !== 1 || faces[0].score < MIN_FACE_SCORE || faces[0].embedding.length === 0) {
      return { verified: false, reason: 'clear-single-face-required' };
    }
    recoveryFaces.push(faces[0]);
  }

  if (!registrationPhoto) return { verified: false, reason: 'registration-photo-unavailable' };
  const registrationBuffer = await readRegistrationPhoto(registrationPhoto);
  const registrationFaces = await detectFace(human, registrationBuffer);
  if (registrationFaces.length !== 1 ||
      registrationFaces[0].score < MIN_FACE_SCORE ||
      registrationFaces[0].embedding.length === 0) {
    return { verified: false, reason: 'registration-face-unavailable' };
  }

  const scores = recoveryFaces.map(face =>
    human.match.similarity(registrationFaces[0].embedding, face.embedding)
  );
  const yawValues = recoveryFaces.map(face => face.yaw);
  const yawSpread = Math.max(...yawValues) - Math.min(...yawValues);
  const livenessPassed = recoveryFaces.every(face =>
    Number.isFinite(face.live) && face.live >= MIN_LIVE_SCORE &&
    Number.isFinite(face.real) && face.real >= MIN_REAL_SCORE
  );
  const poseChallengePassed = yawValues.every(Number.isFinite) && yawSpread >= MIN_YAW_SPREAD;
  const matchPassed = scores.every(score => Number.isFinite(score) && score >= 0.8) &&
    Math.max(...scores) >= MIN_MATCH_SCORE;

  return {
    verified: livenessPassed && poseChallengePassed && matchPassed,
    reason: !livenessPassed
      ? 'liveness-check-failed'
      : !poseChallengePassed
        ? 'pose-challenge-failed'
        : !matchPassed
          ? 'face-match-below-threshold'
          : null
  };
}

module.exports = { verifyDriverFace };
