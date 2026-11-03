// ═══════════════════════════════════════════════════════════════════════════
// Object storage for customer/rider images
// ═══════════════════════════════════════════════════════════════════════════
// Payment receipts (up to 8 MB) and rider face photos (up to 9 MB) used to be
// stored as base64 inside the database. That made one order 11–15 KB and, more
// importantly, made every write carry megabytes of image data.
//
// When a Supabase service key is configured we upload the image to a public
// Storage bucket and store only the URL. If Storage is unavailable the caller
// keeps the inline data URL, so the feature still works offline.
// ═══════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  ''
);
const BUCKET = String(process.env.SUPABASE_MEDIA_BUCKET || 'yebs-media').replace(/[^a-zA-Z0-9_-]/g, '') || 'yebs-media';
const MAX_BYTES = 12 * 1024 * 1024;

let bucketPromise = null;
let storageDisabled = false;

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY) && !storageDisabled;
}

function parseDataUrl(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return null;
  const mime = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES) return null;
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return { mime, ext, buffer, base64: match[2] };
}

function authHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    ...extra
  };
}

async function ensureBucket() {
  if (!isConfigured()) return false;
  if (bucketPromise) return bucketPromise;
  bucketPromise = (async () => {
    try {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: MAX_BYTES }),
        signal: AbortSignal.timeout(10000)
      });
      // 400/409 simply means it already exists.
      if (res.ok || [400, 409].includes(res.status)) return true;
      const detail = await res.text().catch(() => '');
      console.warn(`[media] could not create bucket ${BUCKET} (${res.status}): ${detail.slice(0, 160)}`);
      storageDisabled = true;
      return false;
    } catch (err) {
      console.warn('[media] storage unavailable:', err.message);
      storageDisabled = true;
      return false;
    }
  })();
  return bucketPromise;
}

/**
 * Upload a base64 data URL. Returns the public URL, or null when Storage is not
 * configured/available (the caller should keep the inline value).
 */
async function uploadDataUrl(dataUrl, { kind = 'misc', id = '' } = {}) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  if (!(await ensureBucket())) return null;
  const safeKind = String(kind || 'misc').replace(/[^a-zA-Z0-9_-]/g, '') || 'misc';
  const safeId = String(id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '') || String(Date.now());
  const path = `${safeKind}/${safeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${parsed.ext}`;
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: authHeaders({
        'Content-Type': parsed.mime,
        'x-upsert': 'true',
        'cache-control': 'max-age=31536000'
      }),
      body: parsed.buffer,
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.warn(`[media] upload failed (${res.status}): ${detail.slice(0, 160)}`);
      return null;
    }
    return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  } catch (err) {
    console.warn('[media] upload error:', err.message);
    return null;
  }
}

module.exports = { isConfigured, uploadDataUrl, parseDataUrl, BUCKET };
