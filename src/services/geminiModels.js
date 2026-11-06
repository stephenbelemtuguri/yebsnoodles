const crypto = require('crypto');

const MODEL_LIST_TTL_MS = 10 * 60 * 1000;
const MAX_MODEL_PAGES = 10;
let cached = null;

function modelPriority(name) {
  const model = name.toLowerCase();
  if (model.includes('flash-lite')) return 0;
  if (model.includes('flash')) return 1;
  if (model.includes('pro')) return 2;
  return 3;
}

async function listAvailableGeminiModels(apiKey, fetchImpl = globalThis.fetch) {
  const keyHash = crypto.createHash('sha256').update(String(apiKey || '')).digest('hex');
  if (cached && cached.keyHash === keyHash && cached.expiresAt > Date.now()) return cached.models.slice();
  if (!apiKey) return [];

  const models = new Set();
  let pageToken = '';
  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetchImpl(url, {
      headers: { 'x-goog-api-key': apiKey },
      cache: 'no-store',
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) throw new Error(`Gemini model discovery returned HTTP ${response.status}.`);
    const payload = await response.json();
    for (const model of Array.isArray(payload.models) ? payload.models : []) {
      const name = String(model.name || '').replace(/^models\//, '');
      const methods = Array.isArray(model.supportedGenerationMethods) ? model.supportedGenerationMethods : [];
      if (!/^gemini-[a-z0-9._-]+$/i.test(name) ||
          !methods.includes('generateContent') ||
          /embedding|tts|image|audio|live|computer|robotics|veo/i.test(name)) continue;
      models.add(name);
    }
    pageToken = String(payload.nextPageToken || '');
    if (!pageToken) break;
  }

  const result = Array.from(models).sort((a, b) => modelPriority(a) - modelPriority(b) || a.localeCompare(b));
  cached = { keyHash, models: result, expiresAt: Date.now() + MODEL_LIST_TTL_MS };
  return result.slice();
}

function clearGeminiModelCache() {
  cached = null;
}

module.exports = { listAvailableGeminiModels, clearGeminiModelCache };
