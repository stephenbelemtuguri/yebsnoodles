// Netlify Function entry point for the YEBS Noodles API.
// All requests to /api/* are rewritten here by netlify.toml.

// The Express app refuses to boot in production without JWT_SECRET. The portals
// authenticate with the app's own HMAC tokens (YEBS_AUTH_SECRET); JWT_SECRET is
// only read by the optional JWT middleware, so derive a stable fallback instead
// of failing every single request when it has not been configured.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = process.env.YEBS_AUTH_SECRET
    || require('crypto').randomBytes(48).toString('hex');
}

const serverless = require('serverless-http');
const store = require('../../src/data/store');
const { app, start } = require('../../server');

const handler = serverless(app);

let bootPromise = null;

// Netlify can hand over either the function path
// (/.netlify/functions/api/orders) or, depending on how the rewrite is applied,
// the visitor-facing path (/api/orders). Normalise both to /api/…
function pathForExpress(event) {
  let raw = String(event.path || '/');
  if (event.rawUrl) {
    try {
      const rawPath = new URL(event.rawUrl).pathname;
      if (rawPath && rawPath.startsWith('/api')) raw = rawPath;
    } catch (e) { /* ignore malformed URLs */ }
  }
  if (raw.startsWith('/.netlify/functions/api')) {
    raw = raw.slice('/.netlify/functions/api'.length) || '/';
  }
  if (raw.startsWith('/api/') || raw === '/api') return raw;
  return '/api' + (raw.startsWith('/') ? raw : `/${raw}`);
}

exports.handler = async (event, context) => {
  if (!bootPromise) bootPromise = start();

  try {
    await bootPromise;
  } catch (err) {
    bootPromise = null;
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        message: `Database unavailable: ${err.message}`,
        hint: 'Check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the yebs_state table.'
      })
    };
  }

  // Pick up anything another instance wrote (short TTL, no-op locally).
  await store.refresh();

  const path = pathForExpress(event);
  const rewritten = { ...event, path, rawUrl: String(event.rawUrl || '').replace('/.netlify/functions/api', '/api') };

  try {
    const response = await handler(rewritten, context);
    // Make sure the latest order/driver state reached Supabase before the
    // function is frozen.
    await store.flush();
    return response;
  } catch (err) {
    console.error('[api] unhandled', err);
    await store.flush();
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: false, message: err && err.message ? err.message : 'Server error' })
    };
  }
};
