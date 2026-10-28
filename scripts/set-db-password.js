#!/usr/bin/env node
// Set the Supabase database password in .env, then create/verify the table.
//
// Usage (PowerShell):
//   node scripts/set-db-password.js "PASTE_THE_DATABASE_PASSWORD_HERE"
//   npm run db:password -- "PASTE_THE_DATABASE_PASSWORD_HERE"
//
// The password is written to DATABASE_PASSWORD (raw, URL-encoded for you) and
// into the password slot of DATABASE_URL, DATABASE_POOL_URL and DIRECT_URL.
// Characters like @ : # / are handled automatically - do not encode them
// yourself. The password is never printed.
//
// Add --no-setup to only update .env without connecting.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ENV_PATH = path.join(__dirname, '..', '.env');
const args = process.argv.slice(2);
const runSetup = !args.includes('--no-setup');
const password = args.filter(a => a !== '--no-setup').join(' ').trim();

const PLACEHOLDERS = [
  '', 'your-password', '[your-password]', 'your_password', 'change-me',
  'changeme', 'placeholder', 'password', 'example'
];

function fail(message) {
  console.error(`\n[password] ${message}\n`);
  process.exit(1);
}

if (!password) {
  fail([
    'No password given.',
    '',
    'Run:  node scripts/set-db-password.js "YOUR-SUPABASE-DATABASE-PASSWORD"',
    '',
    'Get it from Supabase -> Project Settings -> Database -> Reset database password.',
    'If you just reset it, copy the new value immediately: Supabase shows it once.'
  ].join('\n'));
}

if (PLACEHOLDERS.includes(password.toLowerCase())) {
  fail('That is still a placeholder, not a real password.');
}

if (/[\r\n]/.test(password)) {
  fail('The password must be a single line.');
}

if (!fs.existsSync(ENV_PATH)) {
  fail(`.env not found at ${ENV_PATH}`);
}

const original = fs.readFileSync(ENV_PATH, 'utf8');
const eol = original.includes('\r\n') ? '\r\n' : '\n';
const lines = original.split(/\r?\n/);

// dotenv treats # as a comment and strips surrounding spaces, so quote the raw
// password and escape the two characters that matter inside double quotes.
const quoted = `"${password.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function encodeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.password = password;
    return url.toString();
  } catch {
    return null;
  }
}

const touched = new Set();
const next = lines.map(line => {
  const match = line.match(/^(\s*)([A-Za-z0-9_]+)(\s*)=(.*)$/);
  if (!match) return line;
  const key = match[2];
  if (key === 'DATABASE_PASSWORD' || key === 'SUPABASE_DB_PASSWORD') {
    touched.add(key);
    return `${match[1]}${key}=${quoted}`;
  }
  if (['DATABASE_URL', 'DATABASE_POOL_URL', 'DIRECT_URL'].includes(key)) {
    const encoded = encodeUrl(match[4].trim());
    if (!encoded) return line;
    touched.add(key);
    return `${match[1]}${key}=${encoded}`;
  }
  return line;
});

if (!touched.has('DATABASE_PASSWORD')) {
  // Keep the block readable: insert next to the other database keys.
  const poolIndex = next.findIndex(l => /^\s*DATABASE_POOL_URL\s*=/.test(l));
  const insertAt = poolIndex === -1 ? next.length : poolIndex + 1;
  next.splice(insertAt, 0, `DATABASE_PASSWORD=${quoted}`);
  touched.add('DATABASE_PASSWORD');
}

fs.writeFileSync(ENV_PATH, next.join(eol), 'utf8');

console.log('\n[password] .env updated:');
for (const key of ['DATABASE_PASSWORD', 'DATABASE_URL', 'DATABASE_POOL_URL', 'DIRECT_URL']) {
  if (touched.has(key)) console.log(`  - ${key}`);
}
console.log('[password] the password is stored raw and URL-encoded automatically.');

if (!runSetup) {
  console.log('\n[password] done. Next: npm run supabase:setup\n');
  process.exit(0);
}

console.log('\n[password] running supabase:setup ...\n');
const result = spawnSync(process.execPath, [path.join(__dirname, 'setup-supabase.js')], {
  stdio: 'inherit',
  env: process.env
});
process.exit(result.status === null ? 1 : result.status);
