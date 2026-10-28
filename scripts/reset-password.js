#!/usr/bin/env node
// Reset an admin or driver password without the web UI.
//
// This is the guaranteed recovery path for the shop owner: it works even when
// WhatsApp/SMS delivery is not configured and the admin cannot sign in.
//
// Usage:
//   npm run reset:password -- admin "MyNewStrongPassword"
//   npm run reset:password -- admin "MyNewStrongPassword" your-username
//   npm run reset:password -- driver "RiderNewPassword" 0541234567
//
// It writes to Supabase when SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set
// in .env (the same store the deployed app uses), otherwise to database.json.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const root = path.join(__dirname, '..');
const TABLE = String(process.env.SUPABASE_STATE_TABLE || 'yebs_state').replace(/[^a-zA-Z0-9_]/g, '') || 'yebs_state';
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  ''
).trim();

const args = process.argv.slice(2).filter(Boolean);
const role = String(args[0] || '').toLowerCase();
const password = String(args[1] || '');
const identifier = String(args[2] || '').trim();

if (role !== 'admin' && role !== 'driver') {
  console.error('Usage: npm run reset:password -- <admin|driver> "<new password>" [username-or-phone]');
  process.exit(1);
}
if (password.length < 8) {
  console.error('[reset] The new password must be at least 8 characters.');
  process.exit(1);
}

const restEnabled = Boolean(SUPABASE_URL && SUPABASE_KEY);

async function readState() {
  if (restEnabled) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.main&select=data`, {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
    });
    if (!res.ok) throw new Error(`Supabase read failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const rows = await res.json();
    if (!rows[0]) throw new Error('The yebs_state row "main" does not exist. Run supabase/setup.sql first.');
    return rows[0].data;
  }
  const file = path.join(root, 'database.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function writeState(data) {
  if (restEnabled) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?id=eq.main`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ data })
    });
    if (!res.ok) throw new Error(`Supabase write failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    return;
  }
  fs.writeFileSync(path.join(root, 'database.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

(async () => {
  const data = await readState();
  const list = role === 'admin' ? (data.admins || []) : (data.drivers || []);
  if (!list.length) {
    console.error(`[reset] No ${role} accounts found.`);
    process.exit(1);
  }

  let account;
  if (identifier) {
    const lower = identifier.toLowerCase();
    const compact = identifier.replace(/\s+/g, '');
    account = list.find(a =>
      String(a.username || '').toLowerCase() === lower ||
      String(a.phone || '').replace(/\s+/g, '') === compact
    );
    if (!account) {
      console.error(`[reset] No ${role} matched "${identifier}".`);
      console.error('        Accounts: ' + list.map(a => a.username || a.phone).join(', '));
      process.exit(1);
    }
  } else {
    account = list[0];
  }

  account.password = bcrypt.hashSync(password, 10);
  account.passwordUpdatedAt = new Date().toISOString();
  account.sessionEpoch = (account.sessionEpoch || 0) + 1;

  await writeState(data);

  console.log(`[reset] ${role} "${account.username || account.phone}" now uses the new password.`);
  console.log('[reset] Every existing session for this account was signed out.');
  console.log(`[reset] Stored in: ${restEnabled ? 'Supabase (' + TABLE + ')' : 'database.json'}`);
})().catch(err => {
  console.error('[reset] ' + err.message);
  process.exit(1);
});
