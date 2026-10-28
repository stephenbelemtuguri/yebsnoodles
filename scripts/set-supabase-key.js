#!/usr/bin/env node
// Save the Supabase secret key and verify the app can read/write yebs_state.
//
// Usage (PowerShell):
//   node scripts/set-supabase-key.js "sb_secret_xxxxxxxxxxxxxxxx"
//   npm run supabase:key -- "sb_secret_xxxxxxxxxxxxxxxx"
//
// Get the key from Supabase -> Project Settings -> API Keys -> secret key
// (the legacy "service_role" JWT also works).
//
// This is the easiest way to connect the app to Supabase: it uses HTTPS
// (PostgREST), so it works from Render, Netlify and any IPv4-only network -
// no database password, no pooler and no IPv6 problems.

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');
const skipVerify = process.argv.includes('--no-verify');
const args = process.argv.slice(2).filter(a => a !== '--no-verify');
const key = args.join(' ').trim();

function fail(message) {
  console.error(`\n[supabase:key] ${message}\n`);
  process.exit(1);
}

if (!key) {
  fail([
    'No key given.',
    '',
    'Run:  node scripts/set-supabase-key.js "sb_secret_xxxxxxxx"',
    '',
    'Supabase -> Project Settings -> API Keys -> secret key.',
    'Do not use the publishable/anon key: it cannot write to yebs_state.'
  ].join('\n'));
}

if (key.startsWith('sb_publishable_') || /"role"\s*:\s*"anon"/.test(key)) {
  fail('That is a publishable/anon key. Use the secret (service_role) key.');
}

if (/[\r\n]/.test(key)) fail('The key must be a single line.');

if (!fs.existsSync(ENV_PATH)) fail(`.env not found at ${ENV_PATH}`);

const original = fs.readFileSync(ENV_PATH, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original.split(/\r?\n/);

const quoted = `"${key.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
let wrote = false;
const next = lines.map(line => {
  const m = line.match(/^(\s*)(SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY|SUPABASE_SECRET_KEY)(\s*)=/);
  if (!m) return line;
  if (!wrote) {
    wrote = true;
    return `${m[1]}SUPABASE_SERVICE_ROLE_KEY=${quoted}`;
  }
  // Drop duplicate key lines so the last value cannot win unexpectedly.
  return null;
});

if (!wrote) {
  const urlIndex = next.findIndex(l => l && /^\s*SUPABASE_URL\s*=/.test(l));
  next.splice(urlIndex === -1 ? next.length : urlIndex + 1, 0, `SUPABASE_SERVICE_ROLE_KEY=${quoted}`);
}

fs.writeFileSync(ENV_PATH, next.filter(l => l !== null).join(eol), 'utf8');
console.log('\n[supabase:key] .env updated: SUPABASE_SERVICE_ROLE_KEY');

const env = Object.fromEntries(
  next.filter(Boolean)
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, '$1')]; })
);

const baseUrl = String(env.SUPABASE_URL || 'https://dujmpwcarxliadnfdydr.supabase.co').replace(/\/+$/, '');
const table = String(env.SUPABASE_STATE_TABLE || 'yebs_state');

if (skipVerify) {
  console.log('[supabase:key] done (verification skipped).\n');
  process.exit(0);
}

(async () => {
  console.log(`[supabase:key] checking ${baseUrl}/rest/v1/${table} ...`);
  try {
    const res = await fetch(`${baseUrl}/rest/v1/${table}?id=eq.main&select=id,updated_at,data`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000)
    });
    const body = await res.text();
    if (res.status === 404 || /PGRST205|does not exist|Could not find the table/i.test(body)) {
      console.error('[supabase:key] the table does not exist yet.');
      console.error('               Run supabase/setup.sql in the Supabase SQL Editor first.');
      process.exitCode = 1;
      return;
    }
    if (!res.ok) {
      console.error(`[supabase:key] REST check failed (${res.status}): ${body.slice(0, 300)}`);
      if (res.status === 401) console.error('               The key is not a valid secret key for this project.');
      process.exitCode = 1;
      return;
    }
    const rows = JSON.parse(body);
    const row = rows && rows[0];
    const data = (row && row.data) || {};
    const admins = Array.isArray(data.admins) ? data.admins.map(a => a.username) : [];
    const menu = Array.isArray(data.menuItems) ? data.menuItems.length : 0;
    console.log(`[supabase:key] connected. row=${row ? row.id : 'none'} menuItems=${menu} admins=[${admins.join(', ')}]`);
    if (!row) {
      console.log('[supabase:key] the table exists but is empty - start the app once and it will seed itself.');
    }
    console.log('[supabase:key] restart the app, then GET /api/health should show "storage": "supabase".\n');
  } catch (err) {
    console.error(`[supabase:key] request failed: ${err.message}`);
    process.exitCode = 1;
  }
})();
