// YEBS Noodles - Unified Express API Backend & Database Server
// Secure auth (bcrypt + HMAC signed sessions), instant payment verification,
// unified order IDs and shared pickup-point state.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const store = require('./src/data/store');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const SECRET_FILE = path.join(__dirname, '.auth-secret');

app.use(cors());
// Photos (driver live face photo + MoMo receipts) are sent as base64 data URLs,
// so the default 100kb JSON limit is far too small.
app.use(express.json({ limit: '12mb' }));

// serverless-http (Netlify Functions) hands the body over as a Buffer/string.
// Normalise it so every JSON handler behaves the same in both modes.
app.use((req, res, next) => {
  if (Buffer.isBuffer(req.body)) {
    const text = req.body.toString('utf8');
    try { req.body = text ? JSON.parse(text) : {}; } catch (e) { req.body = {}; }
  } else if (typeof req.body === 'string' && req.body.length) {
    try { req.body = JSON.parse(req.body); } catch (e) { /* leave original value */ }
  }
  next();
});
app.use(express.static(__dirname, { extensions: ['html', 'htm'] }));

// Never let browsers cache live operational data.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  next();
});

// Friendly clean URL routes
app.get(['/admin', '/dashboard', '/admin-panel'], (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get(['/driver', '/driver-panel', '/rider', '/dispatch'], (req, res) => {
  res.sendFile(path.join(__dirname, 'driver.html'));
});

app.get(['/store', '/menu', '/order', '/track', '/customer'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ==========================================================
// SECURITY PRIMITIVES — bcrypt passwords + HMAC session tokens
// ==========================================================

const BCRYPT_ROUNDS = 10;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// A stable signing secret is generated once and never leaves this machine.
let AUTH_SECRET = process.env.YEBS_AUTH_SECRET || '';
if (!AUTH_SECRET && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)) {
  // Netlify function instances cannot share a generated secret file. Derive a
  // stable one from the service key already present in the environment so an
  // admin signed in on one instance stays signed in on the next.
  AUTH_SECRET = crypto
    .createHmac('sha256', String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY))
    .update('yebs-auth-v1')
    .digest('hex');
  console.warn('[security] YEBS_AUTH_SECRET not set; deriving a stable secret from the Supabase service key. Set YEBS_AUTH_SECRET explicitly to rotate sessions.');
}
if (!AUTH_SECRET) {
  try {
    if (fs.existsSync(SECRET_FILE)) {
      AUTH_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    }
    if (!AUTH_SECRET) {
      AUTH_SECRET = crypto.randomBytes(48).toString('hex');
      fs.writeFileSync(SECRET_FILE, AUTH_SECRET, { mode: 0o600 });
    }
  } catch (e) {
    AUTH_SECRET = crypto.randomBytes(48).toString('hex');
    // Serverless filesystems are read-only and every instance would get a
    // different secret, silently invalidating every token it issued. Shout
    // about it so the deployment is fixed instead of "random logouts".
    console.error('[security] YEBS_AUTH_SECRET is not set. Sessions will not survive between instances - set it in the hosting environment variables.');
  }
}

function hashPassword(plain) {
  // bcrypt generates a unique random salt for every password automatically.
  return bcrypt.hashSync(String(plain), BCRYPT_ROUNDS);
}

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

function verifyPassword(plain, stored) {
  if (!stored) return false;
  if (isBcryptHash(stored)) {
    try { return bcrypt.compareSync(String(plain), stored); } catch (e) { return false; }
  }
  // Legacy plaintext record: compare, then the caller upgrades it to bcrypt.
  return String(plain) === String(stored);
}

function createToken(subject, role, extra = {}) {
  const payload = {
    sub: String(subject),
    role,
    ...extra,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    jti: crypto.randomBytes(12).toString('hex')
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function bearerFrom(req) {
  const raw = req.headers.authorization || '';
  const match = String(raw).match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function authenticate(req) {
  const payload = verifyToken(bearerFrom(req));
  if (!payload) return null;
  const db = loadDatabase();
  if (payload.role === 'admin') {
    const admin = db.admins.find(a => a.id === payload.sub);
    return admin ? { payload, admin } : null;
  }
  if (payload.role === 'driver') {
    const driver = db.drivers.find(d => d.id === payload.sub);
    return driver ? { payload, driver } : null;
  }
  return null;
}

function requireRole(...roles) {
  return (req, res, next) => {
    const auth = authenticate(req);
    if (!auth || !roles.includes(auth.payload.role)) {
      return res.status(401).json({ success: false, message: 'Authentication required. Please sign in again.' });
    }
    req.auth = auth;
    next();
  };
}

// Brute-force protection: 5 failed attempts per identity per 15 minutes.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const loginAttempts = new Map();

function loginKey(req, role, identity) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local').toString().split(',')[0].trim();
  return `${role}|${ip}|${String(identity || '').toLowerCase()}`;
}

function rateCheck(req, role, identity) {
  const key = loginKey(req, role, identity);
  const record = loginAttempts.get(key);
  if (!record) return { blocked: false };
  if (record.blockedUntil && record.blockedUntil > Date.now()) {
    return { blocked: true, retryAfter: Math.ceil((record.blockedUntil - Date.now()) / 1000) };
  }
  if (record.firstAt && (Date.now() - record.firstAt) > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
  }
  return { blocked: false };
}

function rateFail(req, role, identity) {
  const key = loginKey(req, role, identity);
  const record = loginAttempts.get(key) || { count: 0, firstAt: Date.now(), blockedUntil: 0 };
  if ((Date.now() - record.firstAt) > LOGIN_WINDOW_MS) {
    record.count = 0;
    record.firstAt = Date.now();
    record.blockedUntil = 0;
  }
  record.count += 1;
  if (record.count >= LOGIN_MAX_FAILURES) {
    record.blockedUntil = Date.now() + LOGIN_WINDOW_MS;
  }
  loginAttempts.set(key, record);
  return record;
}

function rateSuccess(req, role, identity) {
  loginAttempts.delete(loginKey(req, role, identity));
}

// ==========================================================
// DATABASE
// ==========================================================

// Guarantee the data file always has every collection and at least one
// superadmin. Without this, a database.json that predates the accounts (or was
// committed empty) leaves the platform with no way to sign in or approve drivers.
const DEFAULT_MOMO_SETTINGS = { payTo: '0559103452', accountName: 'MATHEW TIA' };

function ensureSystemAccounts(db) {
  const collections = ['admins', 'drivers', 'orders', 'sessions', 'auditLogs', 'menuItems', 'payouts', 'reviews'];
  let changed = false;

  collections.forEach(key => {
    if (!Array.isArray(db[key])) { db[key] = []; changed = true; }
  });

  if (!db.settings || typeof db.settings !== 'object' || Array.isArray(db.settings)) {
    db.settings = {};
    changed = true;
  }
  if (!db.settings.momo || typeof db.settings.momo !== 'object') {
    db.settings.momo = { ...DEFAULT_MOMO_SETTINGS };
    changed = true;
  } else {
    if (!db.settings.momo.payTo) { db.settings.momo.payTo = DEFAULT_MOMO_SETTINGS.payTo; changed = true; }
    if (!db.settings.momo.accountName) { db.settings.momo.accountName = DEFAULT_MOMO_SETTINGS.accountName; changed = true; }
  }

  if (db.admins.length === 0) {
    db.admins.push({
      id: 'adm-1',
      username: 'yebsnoodles',
      password: hashPassword('yebs@123'),
      name: 'YEBS Administrator',
      role: 'SUPERADMIN',
      createdAt: new Date().toISOString()
    });
    changed = true;
    console.log('[security] Seeded built-in administrator "yebsnoodles".');
  }

  return changed;
}

function loadDatabase() {
  const cached = store.get();
  if (cached) return cached;

  if (!fs.existsSync(DB_FILE)) {
    const initialData = {
      admins: [
        {
          id: "adm-1",
          username: "yebsnoodles",
          password: hashPassword("yebs@123"),
          name: "YEBS Administrator",
          role: "SUPERADMIN",
          createdAt: new Date().toISOString()
        }
      ],
      drivers: [],
      orders: [],
      sessions: [
        {
          id: 1,
          sessionNumber: 1,
          status: "ACTIVE",
          startedAt: new Date().toISOString(),
          intermissionEndsAt: null,
          pickupPoint: {
            name: "Circle Odo Rice Junction / VIP Station",
            lat: 5.5612,
            lng: -0.2155,
            updatedAt: new Date().toISOString()
          }
        }
      ],
      settings: {
        momo: { ...DEFAULT_MOMO_SETTINGS }
      },
      auditLogs: [
        {
          id: "log-init",
          timestamp: new Date().toISOString(),
          action: "SYSTEM_INITIALIZED",
          actor: "SYSTEM",
          entity: "DATABASE",
          details: "YEBS Noodles API initialised with bcrypt-secured accounts."
        }
      ]
    };
    try { fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2)); } catch (e) { /* read-only fs */ }
    ensureSystemAccounts(initialData);
    return initialData;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (ensureSystemAccounts(parsed)) {
      try { fs.writeFileSync(DB_FILE, JSON.stringify(parsed, null, 2)); } catch (e) { /* read-only fs */ }
    }
    return parsed;
  } catch (e) {
    console.error("Database read error, restoring default", e);
    const fallback = {
      admins: [], drivers: [], orders: [], sessions: [], auditLogs: [], menuItems: [], payouts: [], reviews: [],
      settings: { momo: { ...DEFAULT_MOMO_SETTINGS } }
    };
    ensureSystemAccounts(fallback);
    return fallback;
  }
}

function saveDatabase(data) {
  // Memory + Supabase (when configured). The local file is kept in sync so
  // `npm start` behaves exactly as before.
  store.set(data);
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    // Read-only filesystem on Netlify Functions — Supabase already has it.
  }
}

// One-time upgrade of any legacy plaintext passwords to bcrypt.
function migratePasswords() {
  const db = loadDatabase();
  let changed = 0;
  const upgrade = (account, label) => {
    if (account.password && !isBcryptHash(account.password)) {
      account.password = hashPassword(account.password);
      account.passwordUpdatedAt = new Date().toISOString();
      changed += 1;
      console.log(`[security] Upgraded ${label} password to bcrypt.`);
    }
  };
  (db.admins || []).forEach(a => upgrade(a, `admin "${a.username}"`));
  (db.drivers || []).forEach(d => upgrade(d, `driver "${d.username}"`));
  if (changed) {
    db.auditLogs = db.auditLogs || [];
    db.auditLogs.unshift({
      id: "log-migrate-" + Date.now(),
      timestamp: new Date().toISOString(),
      action: "PASSWORDS_REHASHED",
      actor: "SYSTEM",
      entity: "SECURITY",
      details: `${changed} legacy password(s) upgraded to bcrypt with unique salts.`,
      ipOrAgent: "LOCAL"
    });
    saveDatabase(db);
    console.log(`[security] ${changed} password(s) upgraded to bcrypt.`);
  }
  return changed;
}

// Add an Audit Log entry for traceability
function logAction(action, actor, entity, details = null, req = null) {
  const db = loadDatabase();
  db.auditLogs = db.auditLogs || [];
  const logEntry = {
    id: "log-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    timestamp: new Date().toISOString(),
    action,
    actor: actor || "ANONYMOUS",
    entity: entity || "GENERAL",
    details: typeof details === 'object' ? JSON.stringify(details) : details,
    ipOrAgent: req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) : "LOCAL"
  };
  db.auditLogs.unshift(logEntry);
  if (db.auditLogs.length > 500) db.auditLogs.pop();
  saveDatabase(db);
  return logEntry;
}

// Public driver shape (never exposes passwords)
function publicDriver(d) {
  return {
    id: d.id,
    username: d.username,
    name: d.name || `${d.fname || ''} ${d.lname || ''}`.trim(),
    fname: d.fname,
    lname: d.lname,
    phone: d.phone,
    vehicle: d.vehicle,
    photo: d.photo || null,
    isActive: d.isActive !== false,
    isOnline: d.isActive !== false,
    approvalStatus: d.approvalStatus || (d.approvedAt ? 'approved' : 'pending'),
    lat: d.lat,
    lng: d.lng,
    speedKmh: d.speedKmh || 0,
    statusText: d.statusText || 'Available',
    lastLocationUpdate: d.lastLocationUpdate || d.createdAt,
    createdAt: d.createdAt
  };
}

function generateDriverUsername(fname, lname, existingDrivers) {
  const cleanF = (fname || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanL = (lname || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = (cleanF + cleanL) || "driver";
  let username = base;
  let counter = 1;
  while (existingDrivers.some(d => d.username === username)) {
    username = `${base}${counter}`;
    counter++;
  }
  return username;
}

function cleanString(value, max = 400) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function toAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}

// ==========================================================
// ORDER IDS — YB-XXXX where XXXX is the unique pickup PIN
// ==========================================================

function newOrderId(db) {
  const used = new Set((db.orders || []).map(o => String(o.id || '').toUpperCase()));
  const usedPins = new Set((db.orders || []).map(o => String(o.pickupPin || '')));
  for (let i = 0; i < 20000; i++) {
    const n = crypto.randomInt(1000, 10000);
    const id = `YB-${n}`;
    if (!used.has(id) && !usedPins.has(String(n))) return { id, pin: String(n) };
  }
  // Extremely unlikely: deterministic scan for a free 4-digit code.
  for (let n = 1000; n <= 9999; n++) {
    const id = `YB-${n}`;
    if (!used.has(id) && !usedPins.has(String(n))) return { id, pin: String(n) };
  }
  return { id: `YB-${Date.now().toString().slice(-4)}`, pin: Date.now().toString().slice(-4) };
}

function normalizeOrderId(raw) {
  const value = cleanString(raw, 20).toUpperCase().replace(/\s+/g, '');
  if (/^\d{4}$/.test(value)) return `YB-${value}`;
  if (/^YB-?\d{4}$/.test(value)) return `YB-${value.replace(/[^0-9]/g, '')}`;
  return value;
}

function paymentModeFor(paymentLabel) {
  const label = String(paymentLabel || '');
  if (/cash|pay on delivery|on arrival|upon delivery/i.test(label)) return 'cash';
  return 'momo';
}

function paymentFieldsFor(order) {
  return {
    paymentMode: order.paymentMode || paymentModeFor(order.payment),
    paymentNetwork: order.paymentNetwork || normalizeNetwork(order.payment) || null,
    paymentNetworkLabel: (MOMO_NETWORKS[order.paymentNetwork] || {}).label || null,
    paymentStatus: order.paymentStatus || (order.paymentVerified ? 'paid' : 'unpaid'),
    paymentRef: order.paymentRef || order.id,
    paymentVerified: order.paymentVerified === true,
    paidAt: order.paidAt || null,
    verificationMethod: order.verificationMethod || null,
    momoAmount: order.momoAmount || null,
    momoTransactionRef: order.momoTransactionRef || null,
    momoRequestId: order.momoRequestId || null,
    momoRequestStatus: order.momoRequestStatus || null,
    momoRequestAt: order.momoRequestAt || null,
    momoReceipt: order.momoReceipt ? {
      image: order.momoReceipt.image || null,
      transactionRef: order.momoReceipt.transactionRef || '',
      uploadedAt: order.momoReceipt.uploadedAt || null,
      verified: order.momoReceipt.verified === true
    } : null
  };
}

// Public order projection: never leaks other customers' phone numbers,
// private notes, receipt images or payment audit trails.
function projectOrder(order, viewer = 'public') {
  const base = {
    id: order.id,
    pickupPin: order.pickupPin,
    sessionNumber: order.sessionNumber,
    createdAt: order.createdAt,
    customer: order.customer,
    fulfilment: order.fulfilment,
    location: order.location,
    mapPin: order.mapPin,
    timing: order.timing,
    items: order.items || [],
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    total: order.total,
    payment: order.payment,
    status: order.status,
    arrivedAt: order.arrivedAt || null,
    deliveredAt: order.deliveredAt || null,
    verifiedByDriver: order.verifiedByDriver === true,
    meetingPoint: order.meetingPoint || null,
    pickupPointName: order.pickupPointName || null,
    pickupPoint: order.pickupPoint || null,
    driver: order.driver ? {
      id: order.driver.id || null,
      name: order.driver.name || null,
      phone: order.driver.phone || null,
      vehicle: order.driver.vehicle || null,
      photo: order.driver.photo || null,
      currentLocation: order.driver.currentLocation || null,
      lastUpdated: order.driver.lastUpdated || null,
      speedKmh: order.driver.speedKmh || 0,
      statusText: order.driver.statusText || null
    } : null,
    ...paymentFieldsFor(order)
  };

  if (viewer === 'admin' || viewer === 'driver') {
    base.phone = order.phone;
    base.notes = order.notes;
    base.paymentAudit = order.paymentAudit || [];
    base.momoSender = order.momoSender || null;
    base.kitchenAt = order.kitchenAt || null;
    base.enrouteAt = order.enrouteAt || null;
  } else {
    // The customer's own order keeps its receipt so the tracking screen can
    // show what was submitted, but the image is never exposed in list views.
    if (order.momoReceipt && order.momoReceipt.image) {
      base.momoReceipt = {
        image: order.momoReceipt.image,
        transactionRef: order.momoReceipt.transactionRef || '',
        uploadedAt: order.momoReceipt.uploadedAt || null,
        verified: order.momoReceipt.verified === true
      };
    }
  }
  return base;
}

function viewerFromReq(req) {
  const auth = authenticate(req);
  if (!auth) return 'public';
  return auth.payload.role;
}

// ==========================================================
// 1. AUTHENTICATION ENDPOINTS
// ==========================================================

// ADMIN LOGIN — generic errors, rate limited, bcrypt verified.
app.post('/api/auth/admin/login', (req, res) => {
  const username = cleanString(req.body && req.body.username, 80);
  const password = String((req.body && req.body.password) || '');

  if (!username || !password) {
    return res.status(400).json({ success: false, message: "Username and password are required." });
  }

  const limit = rateCheck(req, 'admin', username);
  if (limit.blocked) {
    res.set('Retry-After', String(limit.retryAfter || 900));
    return res.status(429).json({ success: false, message: `Too many attempts. Try again in ${Math.ceil((limit.retryAfter || 900) / 60)} minute(s).` });
  }

  const db = loadDatabase();
  const admin = db.admins.find(a => String(a.username).toLowerCase() === username.toLowerCase());

  if (!admin || !verifyPassword(password, admin.password)) {
    const record = rateFail(req, 'admin', username);
    logAction("ADMIN_LOGIN_FAILED", username, "ADMIN_PORTAL", { reason: "Invalid credentials", attempts: record.count }, req);
    return res.status(401).json({ success: false, message: "Invalid administrator credentials." });
  }

  // Upgrade legacy hashes / plaintext on successful login.
  if (!isBcryptHash(admin.password) || bcrypt.getRounds(admin.password) < BCRYPT_ROUNDS) {
    admin.password = hashPassword(password);
    admin.passwordUpdatedAt = new Date().toISOString();
    saveDatabase(db);
  }

  rateSuccess(req, 'admin', username);
  logAction("ADMIN_LOGIN_SUCCESS", admin.username, "ADMIN_PORTAL", { role: admin.role }, req);

  const token = createToken(admin.id, 'admin', { username: admin.username, name: admin.name });
  res.json({
    success: true,
    message: "Admin authenticated successfully.",
    token,
    expiresInMs: SESSION_TTL_MS,
    admin: {
      id: admin.id,
      username: admin.username,
      name: admin.name,
      role: admin.role,
      token
    }
  });
});

// DRIVER SIGN UP
app.post('/api/auth/driver/signup', (req, res) => {
  const fname = cleanString(req.body && req.body.fname, 60);
  const lname = cleanString(req.body && req.body.lname, 60);
  const phone = cleanString(req.body && req.body.phone, 30);
  const password = String((req.body && req.body.password) || '');
  const vehicle = cleanString(req.body && req.body.vehicle, 120);
  const photo = req.body && req.body.photo ? String(req.body.photo).slice(0, 9 * 1024 * 1024) : null;

  if (!fname || !lname || !phone || !password) {
    return res.status(400).json({ success: false, message: "First name, last name, phone number, and password are required." });
  }
  if (password.length < 6) {
    return res.status(400).json({ success: false, message: "Choose a password with at least 6 characters." });
  }
  if (!vehicle) {
    return res.status(400).json({ success: false, message: "Vehicle type is required." });
  }
  if (!photo) {
    return res.status(400).json({ success: false, message: "A live face photo is required so customers can identify their driver." });
  }

  const db = loadDatabase();
  if (db.drivers.some(d => String(d.phone || '').replace(/\s+/g, '') === phone.replace(/\s+/g, ''))) {
    return res.status(400).json({ success: false, message: "A driver with this phone number is already registered." });
  }

  const username = generateDriverUsername(fname, lname, db.drivers);
  const newDriver = {
    id: "drv-" + Date.now(),
    username,
    password: hashPassword(password),
    fname,
    lname,
    name: `${fname} ${lname}`.trim(),
    phone,
    vehicle,
    photo,
    isActive: false,          // Disabled until admin approves
    approvalStatus: 'pending', // pending | approved | rejected
    approvedAt: null,
    approvedBy: null,
    approvalNotified: false,
    lat: 5.56246,
    lng: -0.21289,
    speedKmh: 0,
    createdAt: new Date().toISOString()
  };

  db.drivers.push(newDriver);
  saveDatabase(db);

  logAction("DRIVER_SIGNUP", username, "DRIVER_PORTAL", { name: newDriver.name, phone, vehicle }, req);

  // No token on signup — driver must wait for admin approval before they can log in
  res.status(201).json({
    success: true,
    pending: true,
    message: `Registration successful! Your application is under review. You will be notified once the admin approves your account.`,
    driverId: newDriver.id,
    driverName: newDriver.name,
    username: newDriver.username
  });
});

// DRIVER LOGIN — username or phone, bcrypt verified.
app.post('/api/auth/driver/login', (req, res) => {
  const username = cleanString(req.body && req.body.username, 80);
  const password = String((req.body && req.body.password) || '');
  if (!username || !password) {
    return res.status(400).json({ success: false, message: "Username and password are required." });
  }

  const limit = rateCheck(req, 'driver', username);
  if (limit.blocked) {
    res.set('Retry-After', String(limit.retryAfter || 900));
    return res.status(429).json({ success: false, message: `Too many attempts. Try again in ${Math.ceil((limit.retryAfter || 900) / 60)} minute(s).` });
  }

  const db = loadDatabase();
  const cleanUser = username.toLowerCase();
  const compact = username.replace(/\s+/g, '');
  const driver = db.drivers.find(d =>
    String(d.username).toLowerCase() === cleanUser ||
    String(d.phone || '').replace(/\s+/g, '') === compact
  );

  if (!driver || !verifyPassword(password, driver.password)) {
    const record = rateFail(req, 'driver', username);
    logAction("DRIVER_LOGIN_FAILED", username, "DRIVER_PORTAL", { reason: "Incorrect credentials", attempts: record.count }, req);
    return res.status(401).json({ success: false, message: "Invalid driver username or password." });
  }

  // Block pending and rejected drivers
  if (driver.approvalStatus === 'pending' || (!driver.approvalStatus && !driver.approvedAt && !driver.isActive)) {
    return res.status(403).json({
      success: false,
      pending: true,
      driverId: driver.id,
      driverName: driver.name,
      message: "Your account is pending admin approval. You will be notified once approved."
    });
  }
  if (driver.approvalStatus === 'rejected') {
    return res.status(403).json({
      success: false,
      rejected: true,
      reason: driver.rejectionReason || 'Your registration was not approved.',
      message: driver.rejectionReason || "Your registration was not approved. Please contact YEBS Noodles for assistance."
    });
  }

  if (!isBcryptHash(driver.password) || bcrypt.getRounds(driver.password) < BCRYPT_ROUNDS) {
    driver.password = hashPassword(password);
    driver.passwordUpdatedAt = new Date().toISOString();
    saveDatabase(db);
  }

  rateSuccess(req, 'driver', username);
  logAction("DRIVER_LOGIN_SUCCESS", driver.username, "DRIVER_PORTAL", { name: driver.name }, req);

  const token = createToken(driver.id, 'driver', { username: driver.username, name: driver.name || `${driver.fname} ${driver.lname}` });
  res.json({
    success: true,
    message: `Welcome back, ${driver.fname}!`,
    token,
    expiresInMs: SESSION_TTL_MS,
    driver: { ...publicDriver(driver), token }
  });
});

// Who am I? Lets a portal validate a remembered token after a restart.
app.get('/api/auth/session', (req, res) => {
  const auth = authenticate(req);
  if (!auth) return res.status(401).json({ success: false, message: "Session expired." });
  res.json({
    success: true,
    role: auth.payload.role,
    expiresAt: auth.payload.exp,
    admin: auth.admin ? { id: auth.admin.id, username: auth.admin.username, name: auth.admin.name, role: auth.admin.role } : undefined,
    driver: auth.driver ? publicDriver(auth.driver) : undefined
  });
});

// ==========================================================
// 2. DRIVER LOCATION & PUBLIC PROFILE API
// ==========================================================

app.post('/api/drivers/:id/location', (req, res) => {
  const { id } = req.params;
  const auth = authenticate(req);
  if (!auth) return res.status(401).json({ success: false, message: "Driver sign-in required." });

  const db = loadDatabase();
  const driver = db.drivers.find(d => d.id === id || d.username === id || (d.phone || '').replace(/\s+/g, '') === String(id).replace(/\s+/g, ''));
  if (!driver) return res.status(404).json({ success: false, message: "Driver not found" });

  if (auth.payload.role === 'driver' && auth.payload.sub !== driver.id) {
    return res.status(403).json({ success: false, message: "You can only update your own live location." });
  }

  const { lat, lng, speedKmh, statusText, name, phone, vehicle, photo, isActive } = req.body || {};
  if (lat !== undefined && lat !== null) driver.lat = Number(lat);
  if (lng !== undefined && lng !== null) driver.lng = Number(lng);
  if (speedKmh !== undefined) driver.speedKmh = Number(speedKmh) || 0;
  if (statusText) driver.statusText = cleanString(statusText, 120);
  if (name) driver.name = cleanString(name, 80);
  if (phone) driver.phone = cleanString(phone, 30);
  if (vehicle) driver.vehicle = cleanString(vehicle, 120);
  if (photo) driver.photo = String(photo).slice(0, 9 * 1024 * 1024);
  if (isActive !== undefined) driver.isActive = !!isActive;
  driver.lastLocationUpdate = new Date().toISOString();

  // Mirror the live GPS position onto every active order handled by this
  // driver so customers on other devices receive it with the order sync.
  db.orders.forEach(o => {
    if (!o.driver) return;
    const sameDriver = (o.driver.id && o.driver.id === driver.id)
      || (o.driver.name || '').toLowerCase() === (driver.name || `${driver.fname} ${driver.lname}`).toLowerCase()
      || (o.driver.phone || '').replace(/\s+/g, '') === (driver.phone || '').replace(/\s+/g, '');
    if (sameDriver && o.status !== 'delivered' && o.status !== 'cancelled') {
      o.driver.currentLocation = { lat: driver.lat, lng: driver.lng };
      o.driver.speedKmh = driver.speedKmh;
      o.driver.lastUpdated = driver.lastLocationUpdate;
      if (driver.photo) o.driver.photo = driver.photo;
      if (driver.phone) o.driver.phone = driver.phone;
      if (driver.vehicle) o.driver.vehicle = driver.vehicle;
    }
  });

  saveDatabase(db);
  res.json({ success: true, driver: publicDriver(driver) });
});

// Public: All drivers (safe public fields only)
app.get('/api/drivers', (req, res) => {
  const db = loadDatabase();
  res.json(db.drivers.map(publicDriver));
});

// Public: Get active driver details for customers
app.get('/api/drivers/active', (req, res) => {
  const db = loadDatabase();
  res.json(db.drivers.filter(d => d.isActive).map(publicDriver));
});

// ==========================================================
// 3. PAYMENTS — instant, transparent, conflict-free
// ==========================================================

function addPaymentAudit(order, action, actor, details) {
  order.paymentAudit = order.paymentAudit || [];
  order.paymentAudit.unshift({
    at: new Date().toISOString(),
    action,
    actor: actor || 'SYSTEM',
    details: details || null
  });
  if (order.paymentAudit.length > 40) order.paymentAudit.pop();
}

function validTxnRef(value) {
  const ref = cleanString(value, 60).replace(/\s+/g, '');
  return /^[A-Za-z0-9._-]{5,50}$/.test(ref) ? ref : '';
}

function findDuplicateTxn(db, txn, orderId) {
  const needle = txn.toLowerCase();
  return db.orders.find(o =>
    String(o.id) !== String(orderId) &&
    String(o.momoTransactionRef || '').toLowerCase() === needle
  );
}

function hashReceipt(image) {
  if (!image || typeof image !== 'string') return '';
  return crypto.createHash('sha256').update(image).digest('hex').slice(0, 24);
}

function findDuplicateReceipt(db, hash, orderId) {
  if (!hash) return null;
  return db.orders.find(o => String(o.id) !== String(orderId) && o.momoReceipt && o.momoReceipt.hash === hash);
}

// ==========================================================
// MOBILE MONEY NETWORKS + COLLECTIONS API
// ----------------------------------------------------------
// Every Ghanaian wallet settles into the same YEBS merchant number.
// MTN additionally publishes a Collections API; when the owner adds the
// real credentials (see DEPLOY_NETLIFY.md) the server pushes a payment
// prompt straight to the customer's phone. Without credentials we fall
// back to the USSD flow on the exact same wallet rail, then the customer
// confirms with the transaction ID / receipt.
// ==========================================================

function getMomoSettings(db) {
  const stored = (db && db.settings && db.settings.momo) || {};
  const payTo = walletPhone(stored.payTo) || walletPhone(process.env.MOMO_PAY_TO) || DEFAULT_MOMO_SETTINGS.payTo;
  const accountName = String(stored.accountName || process.env.MOMO_MERCHANT_NAME || DEFAULT_MOMO_SETTINGS.accountName).trim();
  return {
    payTo,
    payToLabel: payTo.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3'),
    accountName
  };
}

const MOMO_NETWORKS = {
  mtn: {
    id: 'mtn',
    label: 'MTN Mobile Money',
    shortLabel: 'MTN MoMo',
    ussd: '*170#',
    dial: '*170',
    prefixes: ['024', '054', '055', '059', '025'],
    supportsApi: true,
    color: '#facc15',
    textColor: '#713f12'
  },
  telecel: {
    id: 'telecel',
    label: 'Telecel Cash (formerly Vodafone Cash)',
    shortLabel: 'Telecel Cash',
    ussd: '*110#',
    dial: '*110',
    prefixes: ['020', '050'],
    supportsApi: false,
    color: '#ef4444',
    textColor: '#ffffff'
  },
  at: {
    id: 'at',
    label: 'AT Money (AirtelTigo)',
    shortLabel: 'AT Money',
    ussd: '*110#',
    dial: '*110',
    prefixes: ['026', '027', '056', '057'],
    supportsApi: false,
    color: '#0ea5e9',
    textColor: '#ffffff'
  }
};

function listMomoNetworks() {
  const api = momoApiConfig();
  return Object.values(MOMO_NETWORKS).map(n => ({
    id: n.id,
    label: n.label,
    shortLabel: n.shortLabel,
    ussd: n.ussd,
    dial: n.dial,
    color: n.color,
    textColor: n.textColor,
    apiReady: !!(n.supportsApi && api.configured)
  }));
}

function normalizeNetwork(value) {
  const v = String(value || '').toLowerCase().trim();
  if (!v) return '';
  if (/mtn|^0?55|momo/.test(v) && !/telecel|vodafone|airtel|tigo/.test(v)) return 'mtn';
  if (/telecel|vodafone|voda/.test(v)) return 'telecel';
  if (/airtel|tigo|\bat\b|atmoney|at-money/.test(v)) return 'at';
  if (/cash|delivery|on arrival/.test(v)) return 'cash';
  return '';
}

// Best-effort network guess from a Ghanaian wallet number.
function networkFromPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '').replace(/^233/, '0');
  const prefix = digits.slice(0, 3);
  for (const net of Object.values(MOMO_NETWORKS)) {
    if (net.prefixes.includes(prefix)) return net.id;
  }
  return '';
}

function walletPhone(value) {
  const digits = String(value || '').replace(/\D/g, '').replace(/^233/, '0');
  return /^0\d{9}$/.test(digits) ? digits : '';
}

function momoApiConfig() {
  const cfg = {
    subscriptionKey: process.env.MTN_MOMO_SUBSCRIPTION_KEY || process.env.MOMO_SUBSCRIPTION_KEY || '',
    apiUser: process.env.MTN_MOMO_API_USER || process.env.MOMO_API_USER || '',
    apiKey: process.env.MTN_MOMO_API_KEY || process.env.MOMO_API_KEY || '',
    targetEnvironment: process.env.MTN_MOMO_TARGET_ENV || process.env.MOMO_TARGET_ENV || 'mtnghana',
    callbackHost: process.env.MTN_MOMO_CALLBACK_HOST || process.env.MOMO_CALLBACK_HOST || ''
  };
  cfg.configured = !!(cfg.subscriptionKey && cfg.apiUser && cfg.apiKey);
  return cfg;
}

async function momoFetch(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    let body = null;
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch (e) { body = text.slice(0, 400); }
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// Exchange API user/key for an OAuth token (MTN Collections v1_0).
async function momoAccessToken(cfg) {
  const basic = Buffer.from(`${cfg.apiUser}:${cfg.apiKey}`).toString('base64');
  const res = await momoFetch(`${cfg.baseUrl || 'https://proxy.momoapi.mtn.com'}/collection/token/`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Ocp-Apim-Subscription-Key': cfg.subscriptionKey
    }
  });
  if (!res.ok || !res.body || !res.body.access_token) {
    throw new Error(`MTN token request failed (${res.status})`);
  }
  return res.body.access_token;
}

// Push a real MoMo payment prompt to the customer's phone.
// Returns { ok, configured, status, referenceId, message }.
async function requestMomoCollection({ amount, phone, referenceId, payerMessage, payeeNote }) {
  const cfg = momoApiConfig();
  if (!cfg.configured) {
    return {
      ok: false,
      configured: false,
      status: 'ussd',
      message: 'Card-free MoMo request is not enabled on this deployment. Use the USSD code below and confirm with your transaction ID.'
    };
  }

  try {
    const token = await momoAccessToken(cfg);
    const base = cfg.baseUrl || 'https://proxy.momoapi.mtn.com';
    const res = await momoFetch(`${base}/collection/v1_0/requesttopay`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Reference-Id': referenceId,
        'X-Target-Environment': cfg.targetEnvironment,
        'Ocp-Apim-Subscription-Key': cfg.subscriptionKey,
        'Content-Type': 'application/json',
        ...(cfg.callbackHost ? { 'X-Callback-Url': `https://${cfg.callbackHost}/api/payments/momo/callback` } : {})
      },
      body: JSON.stringify({
        amount: String(Number(amount).toFixed(2)),
        currency: 'GHS',
        externalId: String(referenceId),
        payer: { partyIdType: 'MSISDN', partyId: String(phone).replace(/^0/, '233') },
        payerMessage: String(payerMessage || 'YEBS Noodles order').slice(0, 60),
        payeeNote: String(payeeNote || 'YEBS Noodles').slice(0, 60)
      })
    }, 20000);

    if (res.status === 202) {
      return {
        ok: true,
        configured: true,
        status: 'pending',
        referenceId,
        message: 'Payment request sent. Approve the prompt on your phone by entering your MoMo PIN.'
      };
    }
    return {
      ok: false,
      configured: true,
      status: 'failed',
      referenceId,
      message: (res.body && (res.body.message || res.body.error)) || `MTN rejected the request (${res.status}). Use the USSD code instead.`
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      status: 'error',
      referenceId,
      message: `Could not reach MTN MoMo (${err.message}). Use the USSD code instead.`
    };
  }
}

// Ask MTN whether a request-to-pay has settled.
async function fetchMomoRequestStatus(referenceId) {
  const cfg = momoApiConfig();
  if (!cfg.configured) return { configured: false, status: 'unknown' };
  try {
    const token = await momoAccessToken(cfg);
    const base = cfg.baseUrl || 'https://proxy.momoapi.mtn.com';
    const res = await momoFetch(`${base}/collection/v1_0/requesttopay/${encodeURIComponent(referenceId)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Target-Environment': cfg.targetEnvironment,
        'Ocp-Apim-Subscription-Key': cfg.subscriptionKey
      }
    });
    if (!res.ok || !res.body) return { configured: true, status: 'unknown' };
    return {
      configured: true,
      status: String(res.body.status || 'unknown').toLowerCase(),
      reason: res.body.reason || null,
      amount: res.body.amount || null
    };
  } catch (err) {
    return { configured: true, status: 'unknown', error: err.message };
  }
}

// Pull a lat/lng out of a Google/Apple Maps link or a raw "5.55, -0.21" string.
function extractCoordinates(text) {
  const value = String(text || '');
  if (!value) return null;
  const patterns = [
    /@(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/,
    /[?&](?:q|query|ll|destination|daddr)=(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/,
    /!3d(-?\d{1,2}\.\d{3,})!4d(-?\d{1,3}\.\d{3,})/,
    /(?:^|\s)(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})(?:$|\s)/
  ];
  for (const re of patterns) {
    const m = value.match(re);
    if (m) {
      const lat = Number(m[1]);
      const lng = Number(m[2]);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { lat, lng };
      }
    }
  }
  return null;
}

// Core MoMo verification used by customer proof, admin SMS matching and receipts.
function applyMomoPayment(db, order, opts) {
  const { transactionRef, amount, sender, receiptImage, method, actor, note } = opts;

  if (order.paymentStatus === 'paid') {
    return {
      ok: true,
      alreadyPaid: true,
      order,
      message: `This order is already paid (${order.verificationMethod === 'cash-driver' ? 'cash collected by rider' : 'MoMo verified'}). No further payment is needed.`
    };
  }

  const total = Number(order.total) || 0;
  const paidAmount = amount === null || amount === undefined ? total : Number(amount);
  if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
    return { ok: false, status: 400, order, message: "Enter the amount you paid." };
  }

  const txn = validTxnRef(transactionRef);
  const receiptHash = hashReceipt(receiptImage);

  // A screenshot already used on another order is evidence of reuse/fraud.
  const dupReceipt = findDuplicateReceipt(db, receiptHash, order.id);
  if (dupReceipt) {
    order.paymentStatus = 'review';
    addPaymentAudit(order, 'MOMO_RECEIPT_DUPLICATE', actor, { matchedOrder: dupReceipt.id });
    return {
      ok: false,
      status: 409,
      order,
      conflict: true,
      message: `This exact receipt was already used for order ${dupReceipt.id}. Submit your own payment proof or pay cash on delivery.`
    };
  }

  if (txn) {
    const dup = findDuplicateTxn(db, txn, order.id);
    if (dup) {
      order.paymentStatus = 'review';
      addPaymentAudit(order, 'MOMO_TXN_DUPLICATE', actor, { matchedOrder: dup.id, transactionRef: txn });
      return {
        ok: false,
        status: 409,
        order,
        conflict: true,
        message: `Transaction ${txn} was already used for order ${dup.id}. Each payment can only verify one order.`
      };
    }
  }

  // Store the submitted proof regardless of the outcome (full transparency).
  order.momoTransactionRef = txn || order.momoTransactionRef || (receiptHash ? `RECEIPT-${receiptHash.slice(0, 8).toUpperCase()}` : null);
  order.momoAmount = paidAmount;
  order.momoSender = sender ? cleanString(sender, 40) : (order.momoSender || null);
  order.momoReceipt = {
    image: receiptImage || (order.momoReceipt && order.momoReceipt.image) || null,
    transactionRef: order.momoTransactionRef,
    uploadedAt: new Date().toISOString(),
    verified: false,
    hash: receiptHash || (order.momoReceipt && order.momoReceipt.hash) || null
  };

  if (Math.abs(paidAmount - total) > 0.009) {
    order.paymentStatus = 'review';
    addPaymentAudit(order, 'MOMO_AMOUNT_MISMATCH', actor, { expected: total, received: paidAmount, note: note || null });
    return {
      ok: false,
      status: 202,
      order,
      needsReview: true,
      message: `We received GH₵${paidAmount.toFixed(2)} but this order total is GH₵${total.toFixed(2)}. It has been flagged for a quick admin check — your order is still being prepared.`
    };
  }

  if (!txn && !receiptImage) {
    return { ok: false, status: 400, order, message: "Enter the MoMo transaction ID or upload the payment receipt." };
  }

  order.paymentStatus = 'paid';
  order.paymentVerified = true;
  order.paidAt = new Date().toISOString();
  order.verificationMethod = method || (receiptImage && !txn ? 'auto-receipt' : 'auto-momo');
  order.momoReceipt.verified = true;
  addPaymentAudit(order, 'MOMO_PAYMENT_VERIFIED', actor, {
    transactionRef: order.momoTransactionRef,
    amount: paidAmount,
    method: order.verificationMethod
  });

  return {
    ok: true,
    order,
    message: `Payment confirmed ✅ GH₵${paidAmount.toFixed(2)} received for order ${order.id}. You are all set — no need to wait.`
  };
}

// Customer submits proof: instant verification, order is never blocked.
app.post('/api/orders/:id/pay/momo', (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });

  const body = req.body || {};
  const amount = toAmount(body.amount);
  const result = applyMomoPayment(db, order, {
    transactionRef: body.transactionRef,
    amount: amount === null ? Number(order.total) : amount,
    sender: body.senderPhone || body.sender,
    receiptImage: body.receiptImage ? String(body.receiptImage).slice(0, 9 * 1024 * 1024) : null,
    method: body.method,
    actor: order.customer || 'CUSTOMER',
    note: body.note
  });

  saveDatabase(db);
  logAction(result.ok ? (result.alreadyPaid ? 'MOMO_ALREADY_PAID' : 'MOMO_AUTO_VERIFIED') : 'MOMO_PAYMENT_REVIEW',
    order.customer, order.id, {
      amount: order.momoAmount,
      transactionRef: order.momoTransactionRef,
      status: order.paymentStatus,
      conflict: !!result.conflict
    }, req);

  res.status(result.ok ? 200 : (result.status || 400)).json({
    success: result.ok,
    alreadyPaid: !!result.alreadyPaid,
    needsReview: !!result.needsReview,
    conflict: !!result.conflict,
    message: result.message,
    order: projectOrder(order, 'public')
  });
});

// Public: which MoMo networks/USSD codes this deployment supports.
app.get('/api/payments/networks', (req, res) => {
  const wallet = getMomoSettings(loadDatabase());
  res.json({
    success: true,
    payTo: wallet.payTo,
    payToLabel: wallet.payToLabel,
    merchant: wallet.accountName,
    accountName: wallet.accountName,
    apiConfigured: momoApiConfig().configured,
    networks: listMomoNetworks()
  });
});

// Customer chooses "Pay now" + a network: push a real MoMo prompt when the
// Collections API is configured, otherwise return the exact USSD steps.
app.post('/api/orders/:id/pay/request', async (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found." });

  if (order.paymentStatus === 'paid') {
    return res.status(200).json({
      success: true,
      alreadyPaid: true,
      message: "This order is already paid.",
      order: projectOrder(order, 'public')
    });
  }

  const body = req.body || {};
  const network = normalizeNetwork(body.network || body.paymentNetwork || order.paymentNetwork || order.payment);
  if (!network || network === 'cash') {
    return res.status(400).json({ success: false, message: "Choose MTN MoMo, Telecel Cash or AT Money first." });
  }
  const net = MOMO_NETWORKS[network];
  if (!net) return res.status(400).json({ success: false, message: "Unknown mobile money network." });

  const phone = walletPhone(body.phone || body.senderPhone || order.momoPayerPhone);
  if (!phone) {
    return res.status(400).json({ success: false, message: "Enter the mobile money number that will pay (e.g. 024 123 4567)." });
  }

  const amount = Number(order.total) || 0;
  const referenceId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

  order.paymentNetwork = network;
  order.payment = net.label;
  order.paymentMode = 'momo';
  order.momoPayerPhone = phone;

  const result = network === 'mtn'
    ? await requestMomoCollection({
        amount,
        phone,
        referenceId,
        payerMessage: `YEBS order ${order.id}`,
        payeeNote: `YEBS Noodles ${order.id}`
      })
    : {
        ok: false,
        configured: false,
        status: 'ussd',
        message: 'Pay from your wallet with the USSD code below, then confirm with the transaction ID.'
      };

  if (result.configured && result.ok) {
    order.momoRequestId = referenceId;
    order.momoRequestStatus = 'pending';
    order.momoRequestAt = new Date().toISOString();
  } else {
    order.momoRequestId = null;
    order.momoRequestStatus = result.configured ? (result.status || 'failed') : 'ussd';
  }

  addPaymentAudit(order, result.ok ? 'MOMO_REQUEST_SENT' : 'MOMO_USSD_INSTRUCTIONS', order.customer, {
    network,
    phone,
    amount,
    mode: result.configured ? 'api' : 'ussd',
    status: order.momoRequestStatus
  });
  saveDatabase(db);
  logAction(result.ok ? 'MOMO_REQUEST_SENT' : 'MOMO_USSD_INSTRUCTIONS', order.customer, order.id, {
    network, amount, mode: result.configured ? 'api' : 'ussd'
  }, req);

  res.json({
    success: true,
    requested: result.ok,
    configured: result.configured,
    mode: result.configured ? 'api' : 'ussd',
    status: order.momoRequestStatus,
    reference: result.configured ? referenceId : order.id,
    network,
    networkLabel: net.label,
    ussd: net.ussd,
    dial: net.dial,
    payTo: getMomoSettings(db).payTo,
    payToLabel: getMomoSettings(db).payToLabel,
    merchant: getMomoSettings(db).accountName,
    amount,
    phone,
    message: result.message,
    order: projectOrder(order, 'public')
  });
});

// Poll a pushed MoMo request; auto-marks the order paid when MTN settles it.
app.get('/api/orders/:id/pay/status', async (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found." });

  let networkStatus = order.momoRequestStatus || null;

  if (order.paymentStatus !== 'paid' && order.momoRequestId) {
    const state = await fetchMomoRequestStatus(order.momoRequestId);
    if (state.configured && state.status && state.status !== 'unknown') {
      networkStatus = state.status;
      order.momoRequestStatus = state.status;
      if (state.status === 'successful') {
        applyMomoPayment(db, order, {
          transactionRef: order.momoRequestId,
          amount: Number(order.total),
          sender: order.momoPayerPhone,
          method: 'mtn-api',
          actor: 'MTN MOMO API',
          note: 'Settled by MTN Collections API'
        });
        logAction('MOMO_API_SETTLED', 'MTN MOMO API', order.id, { amount: order.total }, req);
      }
      saveDatabase(db);
    }
  }

  res.json({
    success: true,
    paid: order.paymentStatus === 'paid',
    paymentStatus: order.paymentStatus,
    requestStatus: networkStatus,
    message: order.paymentStatus === 'paid'
      ? 'Payment confirmed by the mobile money network.'
      : (networkStatus === 'failed' ? 'The mobile money network declined this request. Try again or use the USSD code.' : 'Waiting for the customer to approve the payment prompt.'),
    order: projectOrder(order, 'public')
  });
});

// Rider collects cash on delivery — auto-validated against the order total.
app.post('/api/orders/:id/pay/cash', requireRole('driver', 'admin'), (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });

  if (order.paymentStatus === 'paid') {
    return res.status(409).json({
      success: false,
      conflict: true,
      message: `${order.id} is already paid (${order.verificationMethod === 'cash-driver' ? 'cash already collected' : 'MoMo verified'}). Do not collect cash again.`,
      order: projectOrder(order, req.auth.payload.role)
    });
  }

  const total = Number(order.total) || 0;
  const received = toAmount((req.body || {}).amount);
  if (received === null || received <= 0) {
    return res.status(400).json({ success: false, message: "Enter the cash amount received from the customer." });
  }

  const actorName = req.auth.payload.role === 'driver'
    ? (req.auth.driver.name || req.auth.driver.username)
    : (req.auth.admin.name || req.auth.admin.username);

  order.momoAmount = received;
  order.momoTransactionRef = `CASH-${Date.now().toString(36).toUpperCase()}`;
  order.paymentMode = 'cash';
  order.payment = 'Pay on Delivery (Cash)';
  order.verificationMethod = 'cash-driver';
  order.cashCollectedBy = actorName;
  order.cashCollectedAt = new Date().toISOString();

  if (Math.abs(received - total) > 0.009 && received < total) {
    order.paymentStatus = 'review';
    addPaymentAudit(order, 'CASH_SHORT', actorName, { expected: total, received });
    saveDatabase(db);
    logAction('CASH_PAYMENT_SHORT', actorName, order.id, { expected: total, received }, req);
    return res.status(202).json({
      success: false,
      needsReview: true,
      message: `Cash received GH₵${received.toFixed(2)} is less than the GH₵${total.toFixed(2)} total. Ask for the balance or flag it to the admin.`,
      order: projectOrder(order, req.auth.payload.role)
    });
  }

  order.paymentStatus = 'paid';
  order.paymentVerified = true;
  order.paidAt = new Date().toISOString();
  addPaymentAudit(order, 'CASH_COLLECTED', actorName, { received, expected: total });

  saveDatabase(db);
  logAction('CASH_PAYMENT_COLLECTED', actorName, order.id, { received, expected: total }, req);

  res.json({
    success: true,
    message: `Cash payment of GH₵${received.toFixed(2)} verified and recorded. ${order.id} is fully paid.`,
    order: projectOrder(order, req.auth.payload.role)
  });
});

// Admin override / review outcome.
app.post('/api/orders/:id/pay/review', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });

  const paid = (req.body || {}).paid !== false;
  const reason = cleanString((req.body || {}).reason, 240);
  const actor = req.auth.admin.name || req.auth.admin.username;

  if (paid) {
    order.paymentStatus = 'paid';
    order.paymentVerified = true;
    order.paidAt = order.paidAt || new Date().toISOString();
    order.verificationMethod = order.verificationMethod || 'admin-manual';
    if (order.momoReceipt) order.momoReceipt.verified = true;
    addPaymentAudit(order, 'PAYMENT_APPROVED_BY_ADMIN', actor, { reason });
  } else {
    order.paymentStatus = 'review';
    order.paymentVerified = false;
    order.paidAt = null;
    if (order.momoReceipt) order.momoReceipt.verified = false;
    addPaymentAudit(order, 'PAYMENT_REJECTED_BY_ADMIN', actor, { reason });
  }

  saveDatabase(db);
  logAction(paid ? 'PAYMENT_APPROVED_BY_ADMIN' : 'PAYMENT_REJECTED_BY_ADMIN', actor, order.id, { reason }, req);
  res.json({ success: true, message: paid ? 'Payment approved.' : 'Payment rejected and flagged for review.', order: projectOrder(order, 'admin') });
});

// Parse a forwarded MoMo SMS and auto-match it to an unpaid order.
function parseMomoSms(raw) {
  const text = cleanString(raw, 700);
  const amountMatch = text.match(/(?:GH\s*[₵C]?|GHS|GHC|GH₵)\s*([\d,]+(?:\.\d{1,2})?)/i)
    || text.match(/(?:amount|received|paid)[^\d]{0,24}([\d,]+(?:\.\d{1,2})?)/i);
  const txnMatch = text.match(/(?:transaction\s*(?:id|no|number|ref(?:erence)?)|txn\s*(?:id|no)?|reference|ref)\s*[:\-]?\s*([A-Za-z0-9._-]{5,50})/i);
  const orderMatch = text.match(/(YB[\s-]?\d{4})/i);
  return {
    amount: amountMatch ? Number(String(amountMatch[1]).replace(/,/g, '')) : null,
    transactionRef: txnMatch ? validTxnRef(txnMatch[1]) : '',
    orderId: orderMatch ? normalizeOrderId(orderMatch[1]) : '',
    raw: text
  };
}

app.post('/api/payments/momo/sms', requireRole('admin'), (req, res) => {
  const parsed = parseMomoSms((req.body || {}).sms);
  if (!parsed.amount) {
    return res.status(400).json({ success: false, message: "Could not read an amount from that message. Paste the full MoMo confirmation SMS." });
  }

  const db = loadDatabase();
  let order = parsed.orderId ? db.orders.find(o => String(o.id).toUpperCase() === parsed.orderId) : null;

  if (!order && parsed.transactionRef) {
    order = db.orders.find(o => String(o.momoTransactionRef || '').toLowerCase() === parsed.transactionRef.toLowerCase());
  }

  if (!order) {
    // Only auto-match by amount when exactly one unpaid order matches it.
    const candidates = db.orders.filter(o =>
      o.paymentStatus !== 'paid' &&
      Math.abs(Number(o.total) - parsed.amount) < 0.009
    );
    if (candidates.length === 1) order = candidates[0];
    else if (candidates.length > 1) {
      return res.status(409).json({
        success: false,
        ambiguous: true,
        message: `Amount GH₵${parsed.amount.toFixed(2)} matches ${candidates.length} unpaid orders (${candidates.map(o => o.id).join(', ')}). Include the order ID or reference in the SMS.`,
        parsed
      });
    }
  }

  if (!order) {
    return res.status(404).json({
      success: false,
      message: "No unpaid order matches this message. Check the amount, or include the order ID / transaction reference.",
      parsed
    });
  }

  const result = applyMomoPayment(db, order, {
    transactionRef: parsed.transactionRef,
    amount: parsed.amount,
    sender: (req.body || {}).sender,
    receiptImage: null,
    method: 'auto-sms',
    actor: req.auth.admin.name || req.auth.admin.username,
    note: 'Verified from forwarded MoMo SMS'
  });

  saveDatabase(db);
  logAction(result.ok ? 'MOMO_SMS_AUTO_VERIFIED' : 'MOMO_SMS_REVIEW', req.auth.admin.username, order.id, {
    amount: parsed.amount,
    transactionRef: parsed.transactionRef,
    status: order.paymentStatus
  }, req);

  res.status(result.ok ? 200 : (result.status || 400)).json({
    success: result.ok,
    needsReview: !!result.needsReview,
    conflict: !!result.conflict,
    message: result.message,
    parsed,
    order: projectOrder(order, 'admin')
  });
});

// Legacy receipt upload kept for compatibility; now auto-verifies when valid.
app.post('/api/orders/:id/receipt', (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });

  const body = req.body || {};
  const result = applyMomoPayment(db, order, {
    transactionRef: body.transactionRef,
    amount: toAmount(body.amount) === null ? Number(order.total) : toAmount(body.amount),
    sender: body.senderPhone,
    receiptImage: body.receiptImage ? String(body.receiptImage).slice(0, 9 * 1024 * 1024) : null,
    method: 'auto-receipt',
    actor: order.customer || 'CUSTOMER'
  });

  saveDatabase(db);
  res.status(result.ok ? 200 : (result.status || 400)).json({
    success: result.ok,
    needsReview: !!result.needsReview,
    conflict: !!result.conflict,
    message: result.message,
    order: projectOrder(order, 'public')
  });
});

app.post('/api/orders/:id/receipt/verify', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const order = db.orders.find(o => String(o.id).toUpperCase() === normalizeOrderId(req.params.id));
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });

  const verified = req.body.verified !== false;
  order.paymentStatus = verified ? 'paid' : 'review';
  order.paymentVerified = verified;
  if (verified) order.paidAt = order.paidAt || new Date().toISOString();
  if (order.momoReceipt) order.momoReceipt.verified = verified;
  addPaymentAudit(order, verified ? 'RECEIPT_APPROVED' : 'RECEIPT_REJECTED', req.auth.admin.username, null);
  saveDatabase(db);
  logAction("MOMO_RECEIPT_VERIFIED", req.auth.admin.username, order.id, { verified }, req);
  res.json({ success: true, order: projectOrder(order, 'admin') });
});

// ==========================================================
// 4. ORDERS CRUD & DATABASE PERSISTENCE
// ==========================================================

app.get('/api/orders', (req, res) => {
  const db = loadDatabase();
  const viewer = viewerFromReq(req);
  res.json(db.orders.map(o => projectOrder(o, viewer)));
});

// Driver handover lookup: accepts YB-1234, 1234 or a phone number.
app.get('/api/orders/lookup/:code', requireRole('driver', 'admin'), (req, res) => {
  const db = loadDatabase();
  const raw = cleanString(req.params.code, 30);
  const normalized = normalizeOrderId(raw);
  const compactPhone = raw.replace(/\s+/g, '');

  const matches = db.orders.filter(o =>
    String(o.id).toUpperCase() === normalized ||
    String(o.pickupPin) === raw.replace(/[^0-9]/g, '') ||
    (compactPhone.length >= 9 && String(o.phone || '').replace(/\s+/g, '').endsWith(compactPhone.slice(-9)))
  );

  if (!matches.length) {
    return res.status(404).json({ success: false, message: `No order found for "${raw}". Ask the customer for their Order ID (e.g. YB-1234) or its last 4 digits.` });
  }
  if (matches.length > 1) {
    return res.status(409).json({
      success: false,
      multiple: true,
      message: `${matches.length} orders match that phone number. Use the exact Order ID instead.`,
      orders: matches.map(o => projectOrder(o, req.auth.payload.role))
    });
  }

  res.json({ success: true, order: projectOrder(matches[0], req.auth.payload.role) });
});

app.get('/api/orders/:id', (req, res) => {
  const db = loadDatabase();
  const id = normalizeOrderId(req.params.id);
  const order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });
  res.json(projectOrder(order, viewerFromReq(req)));
});

// ========================================
// FEATURE API ROUTES - Customers, Drivers, Analytics
// ========================================

// Import feature route handlers
// Legacy demo routers (customers, drivers, analytics, reviews, loyalty, receipts,
// chat, inventory, referrals, notifications, pricing) were removed on purpose.
// They returned hard-coded demo numbers that shadowed the real database endpoints
// defined in this file. No page in this build calls those demo routes.

// ========================================
// ORDER SUBMISSION & MANAGEMENT
// ========================================

app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const db = loadDatabase();

  const customer = cleanString(body.customer, 100);
  const phone = cleanString(body.phone, 30);
  if (!customer || !phone) {
    return res.status(400).json({ success: false, message: "Customer name and phone number are required." });
  }

  // Idempotency: if this exact ID already exists, return it untouched.
  const requested = normalizeOrderId(body.id || '');
  if (requested) {
    const existing = db.orders.find(o => String(o.id).toUpperCase() === requested);
    if (existing) return res.status(200).json(projectOrder(existing, 'public'));
  }

  const items = Array.isArray(body.items) ? body.items.slice(0, 30).map(item => {
    const menuItem = (db.menuItems || []).find(m => String(m.id) === String(item.menuId));
    const unit = menuItem ? Number(menuItem.price) : toAmount(item.price);
    const qty = Math.max(1, Math.min(50, Math.floor(Number(item.quantity) || 1)));
    return {
      name: cleanString(item.name || (menuItem && menuItem.name), 100),
      noodle: cleanString(item.noodle, 60),
      menuId: menuItem ? menuItem.id : (item.menuId || null),
      price: unit || 0,
      quantity: qty,
      image: cleanString(item.image, 120)
    };
  }).filter(i => i.name && i.price >= 0) : [];

  if (!items.length) {
    return res.status(400).json({ success: false, message: "Add at least one meal to the order." });
  }

  const subtotal = Math.round(items.reduce((sum, i) => sum + (i.price * i.quantity), 0) * 100) / 100;
  const deliveryFee = String(body.fulfilment || '').toLowerCase() === 'delivery' ? 15 : 0;
  const total = Math.round((subtotal + deliveryFee) * 100) / 100;

  let id = requested;
  let pin;
  if (id && /^YB-\d{4}$/.test(id)) {
    pin = id.slice(-4);
  } else {
    const generated = newOrderId(db);
    id = generated.id;
    pin = generated.pin;
  }

  const currentSession = (db.sessions && db.sessions[0]) || { sessionNumber: 1 };
  const requestedNetwork = normalizeNetwork(body.paymentNetwork);
  const network = requestedNetwork === 'cash' ? '' : (requestedNetwork || normalizeNetwork(body.payment));
  const payment = cleanString(body.payment || (network ? MOMO_NETWORKS[network].label : 'MTN Mobile Money'), 80);
  const paymentMode = paymentModeFor(payment) === 'cash' || requestedNetwork === 'cash' ? 'cash' : 'momo';

  // Prefer an explicit pin, then any coordinates embedded in the address
  // (pasted Google/Apple Maps link), then the Adabraka kitchen default.
  const pinFromAddress = extractCoordinates(body.location);
  const hasPin = body.mapPin && Number.isFinite(Number(body.mapPin.lat)) && Number.isFinite(Number(body.mapPin.lng));
  const orderPin = hasPin
    ? { lat: Number(body.mapPin.lat), lng: Number(body.mapPin.lng) }
    : (pinFromAddress || { lat: 5.5650, lng: -0.2100 });

  const newOrder = {
    id,
    pickupPin: pin,
    // The 4-digit PIN is literally the last 4 digits of the Order ID.
    pickupPinIsOrderId: true,
    sessionNumber: body.sessionNumber || currentSession.sessionNumber,
    createdAt: body.createdAt || new Date().toISOString(),
    customer,
    phone,
    fulfilment: cleanString(body.fulfilment || "Delivery", 40),
    location: cleanString(body.location || "Adabraka, Accra", 200),
    mapPin: orderPin,
    pinSource: hasPin ? 'shared-gps' : (pinFromAddress ? 'map-link' : 'default'),
    timing: cleanString(body.timing || "As soon as possible", 60),
    items,
    subtotal,
    deliveryFee,
    total,
    payment,
    paymentMode,
    paymentNetwork: network || null,
    paymentStatus: 'unpaid',
    paymentRef: id,
    paymentVerified: false,
    paidAt: null,
    verificationMethod: null,
    momoAmount: null,
    momoTransactionRef: null,
    momoRequestId: null,
    momoRequestStatus: null,
    momoRequestAt: null,
    momoPayerPhone: walletPhone(body.payerPhone) || null,
    momoReceipt: null,
    paymentAudit: [],
    notes: cleanString(body.notes, 500),
    status: body.status || "pending",
    verifiedByDriver: false,
    pickupPoint: currentSession.pickupPoint || null,
    pickupPointName: currentSession.pickupPoint ? currentSession.pickupPoint.name : null,
    orderSession: body.orderSession || {
      isActive: true,
      sessionNumber: body.sessionNumber || currentSession.sessionNumber,
      startedAt: new Date().toISOString(),
      endedAt: null
    },
    driver: body.driver || null
  };

  db.orders.unshift(newOrder);
  saveDatabase(db);

  logAction("ORDER_CREATED", customer, newOrder.id, {
    total: newOrder.total,
    pin: newOrder.pickupPin,
    paymentMode: newOrder.paymentMode
  }, req);

  res.status(201).json(projectOrder(newOrder, 'public'));
});

app.patch('/api/orders/:id/status', requireRole('driver', 'admin'), (req, res) => {
  const db = loadDatabase();
  const id = normalizeOrderId(req.params.id);
  const order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });

  const { status, driver, verifiedByDriver } = req.body || {};
  const allowed = ['pending', 'kitchen', 'enroute', 'arrived', 'delivered', 'cancelled'];
  if (status && !allowed.includes(status)) {
    return res.status(400).json({ success: false, message: "Unknown order status." });
  }
  if (status) order.status = status;
  if (driver) order.driver = { ...(order.driver || {}), ...driver };
  if (verifiedByDriver !== undefined) order.verifiedByDriver = !!verifiedByDriver;

  if (order.status === 'kitchen') order.kitchenAt = order.kitchenAt || new Date().toISOString();
  if (order.status === 'enroute') order.enrouteAt = new Date().toISOString();
  if (order.status === 'arrived') order.arrivedAt = new Date().toISOString();
  if (order.status === 'delivered') order.deliveredAt = new Date().toISOString();

  saveDatabase(db);
  logAction("ORDER_STATUS_CHANGED", driver ? driver.name : (req.auth.payload.role === 'admin' ? req.auth.admin.username : 'DRIVER'), order.id, { newStatus: order.status }, req);

  res.json(projectOrder(order, req.auth.payload.role === 'admin' ? 'admin' : 'driver'));
});

// Handover validation: the customer's code must be the last 4 digits of the ID.
app.post('/api/orders/:id/verify-pin', requireRole('driver', 'admin'), (req, res) => {
  const db = loadDatabase();
  const id = normalizeOrderId(req.params.id);
  const order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order) return res.status(404).json({ success: false, message: "Order not found" });

  const entered = cleanString((req.body || {}).pin, 20).replace(/[^0-9]/g, '');
  const expected = String(order.pickupPin || String(order.id).slice(-4));

  if (entered && entered === expected) {
    order.verifiedByDriver = true;
    order.verifiedAt = new Date().toISOString();
    if (order.status !== 'delivered') order.status = 'arrived';
    saveDatabase(db);
    logAction("PIN_VERIFIED", req.auth.payload.role === 'admin' ? req.auth.admin.username : (req.auth.driver.name || 'DRIVER'), order.id, { customer: order.customer }, req);
    return res.json({
      success: true,
      message: `Order ID verified ✅ Hand ${order.id} to ${order.customer}.`,
      order: projectOrder(order, req.auth.payload.role === 'admin' ? 'admin' : 'driver')
    });
  }

  return res.status(400).json({
    success: false,
    message: `That code does not match ${order.id}. The customer's PIN is the last 4 digits of their Order ID.`
  });
});

// ==========================================================
// 5. SESSION & SHARED PICKUP POINT
// ==========================================================

app.get('/api/session', (req, res) => {
  const db = loadDatabase();
  res.json((db.sessions && db.sessions[0]) || {});
});

// Admin or rider sets the pickup point; every portal polls this and updates.
app.post('/api/session/pickup-point', requireRole('admin', 'driver'), (req, res) => {
  const body = req.body || {};
  const name = cleanString(body.pickupPointName || body.name || body.pickupPoint, 140);
  const latRaw = body.coordinates && body.coordinates.lat !== undefined ? body.coordinates.lat : body.lat;
  const lngRaw = body.coordinates && body.coordinates.lng !== undefined ? body.coordinates.lng : body.lng;

  const ACCRA_LANDMARKS = {
    "circle": { lat: 5.5612, lng: -0.2155 },
    "odo rice": { lat: 5.5612, lng: -0.2155 },
    "vip": { lat: 5.5605, lng: -0.2160 },
    "efex": { lat: 5.56246, lng: -0.21289 },
    "adabraka": { lat: 5.5580, lng: -0.2105 },
    "police": { lat: 5.5580, lng: -0.2105 },
    "ridge": { lat: 5.5628, lng: -0.2035 },
    "hospital": { lat: 5.5628, lng: -0.2035 },
    "osu": { lat: 5.5560, lng: -0.1830 },
    "danquah": { lat: 5.5600, lng: -0.1820 },
    "cantonments": { lat: 5.5780, lng: -0.1790 },
    "kaneshie": { lat: 5.5690, lng: -0.2450 }
  };

  let lat = toAmount(latRaw);
  let lng = toAmount(lngRaw);
  const validLat = lat !== null && lat >= -90 && lat <= 90;
  const validLng = lng !== null && lng >= -180 && lng <= 180;

  if (!validLat || !validLng) {
    const lower = name.toLowerCase();
    for (const [key, coords] of Object.entries(ACCRA_LANDMARKS)) {
      if (lower.includes(key)) {
        lat = coords.lat;
        lng = coords.lng;
        break;
      }
    }
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ success: false, message: "Pick a pickup point on the map or choose a landmark so exact coordinates can be saved." });
  }

  const db = loadDatabase();
  const session = (db.sessions && db.sessions[0]) || { sessionNumber: 1 };
  const actor = req.auth.payload.role === 'admin'
    ? (req.auth.admin.name || req.auth.admin.username)
    : (req.auth.driver.name || req.auth.driver.username);

  const newPickupPoint = {
    name: name || "Custom Pickup Point",
    lat: Number(lat),
    lng: Number(lng),
    updatedAt: new Date().toISOString(),
    setBy: actor,
    setByRole: req.auth.payload.role
  };

  session.pickupPoint = newPickupPoint;
  db.sessions = db.sessions && db.sessions.length ? db.sessions : [session];
  db.sessions[0] = session;

  // Keep active orders pointing at the same live pickup point.
  db.orders.forEach(o => {
    if (o.status !== 'delivered' && o.status !== 'cancelled') {
      o.pickupPoint = newPickupPoint;
      o.pickupPointName = newPickupPoint.name;
    }
  });

  saveDatabase(db);
  logAction("PICKUP_POINT_UPDATED", actor, newPickupPoint.name, { lat, lng }, req);

  res.json({ success: true, pickupPoint: newPickupPoint, session });
});

// ==========================================================
// 6. AUDIT LOGS (admin only)
// ==========================================================

app.get('/api/logs', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  res.json(db.auditLogs || []);
});

// ==========================================================
// 7. MENU MANAGEMENT & POSTER CARD TEMPLATES
// ==========================================================
const DEFAULT_POSTER_MENU = [
  {
    id: "spag15",
    name: "SPAGHETTI",
    price: 15,
    noodles: ["Spaghetti"],
    formula: "Add scrambled egg + Cut half sausage",
    desc: "= Add scrambled egg + Cut half sausage",
    image: "img_food_3.jpg",
    badge: "15 CEDIS",
    tag: "Quick Bite",
    template: "poster-capsule"
  },
  {
    id: "indomie20",
    name: "SPAGHETTI / INDOMIE",
    price: 20,
    noodles: ["Spaghetti", "Indomie"],
    formula: "Add scrambled egg + Cut full sausage + Put one egg on top.",
    desc: "= Add scrambled egg + Cut full sausage + Put one egg on top.",
    image: "img_food_2.jpg",
    badge: "20 CEDIS",
    tag: "Bestseller",
    template: "poster-capsule"
  },
  {
    id: "indomie30",
    name: "SPAGHETTI / INDOMIE",
    price: 30,
    noodles: ["Spaghetti", "Indomie"],
    formula: "Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + Free Beta malt",
    desc: "= Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + Free Beta malt",
    image: "img_food_1.jpg",
    badge: "30 CEDIS",
    tag: "Free Beta Malt",
    template: "poster-capsule"
  },
  {
    id: "indomie40",
    name: "SPAGHETTI / INDOMIE",
    price: 40,
    noodles: ["Spaghetti", "Indomie"],
    formula: "Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + One Chicken + Free Beta Malt",
    desc: "= Add scrambled egg + Cut half sausage + Put one egg on top + One sausage + Small Gizzard + One Chicken + Free Beta Malt",
    image: "ghana_spag_chicken.jpg",
    badge: "40 CEDIS",
    tag: "Chicken + Beta Malt",
    template: "poster-capsule"
  },
  {
    id: "indomie60",
    name: "SPAGHETTI / INDOMIE",
    price: 60,
    noodles: ["Spaghetti", "Indomie"],
    formula: "Add scrambled egg + Cut full sausage + Put one egg on top + One sausage + more Gizzard + One Full Chicken (Two pieces) + Free Beta Malt",
    desc: "= Add scrambled egg + Cut full sausage + Put one egg on top + One sausage + more Gizzard + One Full Chicken (Two pieces) + Free Beta Malt",
    image: "img_food_4.jpg",
    badge: "60 CEDIS",
    tag: "Two Chicken + Beta Malt",
    template: "poster-capsule"
  }
];

app.get('/api/menu', (req, res) => {
  const db = loadDatabase();
  if (!db.menuItems || !Array.isArray(db.menuItems) || db.menuItems.length === 0) {
    db.menuItems = DEFAULT_POSTER_MENU;
    saveDatabase(db);
  }
  res.json(db.menuItems);
});

app.post('/api/menu', requireRole('admin'), (req, res) => {
  const { menuItems } = req.body || {};
  if (!Array.isArray(menuItems) || menuItems.length === 0) {
    return res.status(400).json({ success: false, message: "Invalid menuItems array." });
  }
  const db = loadDatabase();
  db.menuItems = menuItems.slice(0, 100);
  saveDatabase(db);
  logAction("MENU_UPDATED", req.auth.admin.username, "MENU", { count: db.menuItems.length }, req);
  res.json({ success: true, menuItems: db.menuItems });
});

app.put('/api/menu/:id', requireRole('admin'), (req, res) => {
  const { id } = req.params;
  const updates = req.body || {};
  const db = loadDatabase();
  if (!db.menuItems || !Array.isArray(db.menuItems) || db.menuItems.length === 0) {
    db.menuItems = [...DEFAULT_POSTER_MENU];
  }
  const idx = db.menuItems.findIndex(m => m.id === id);
  if (idx === -1) {
    return res.status(404).json({ success: false, message: "Menu item not found." });
  }
  db.menuItems[idx] = { ...db.menuItems[idx], ...updates };
  saveDatabase(db);
  logAction("MENU_ITEM_UPDATED", req.auth.admin.username, id, updates, req);
  res.json({ success: true, item: db.menuItems[idx] });
});

app.post('/api/menu/reset', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  db.menuItems = JSON.parse(JSON.stringify(DEFAULT_POSTER_MENU));
  saveDatabase(db);
  logAction("MENU_RESET_TO_POSTER", req.auth.admin.username, "MENU", "Reset to original 15-60 Cedis poster template.", req);
  res.json({ success: true, menuItems: db.menuItems });
});

// ==========================================================
// 8. DRIVER APPROVAL WORKFLOW
// ==========================================================

// Driver signup now creates a pending account awaiting admin approval
// Override the existing signup to mark approvalStatus = 'pending'
// (patch applied at the route level below)

app.post('/api/auth/driver/approve', requireRole('admin'), (req, res) => {
  const { driverId, approved, reason } = req.body || {};
  if (!driverId) return res.status(400).json({ success: false, message: "driverId required." });
  const db = loadDatabase();
  const driver = db.drivers.find(d => d.id === driverId);
  if (!driver) return res.status(404).json({ success: false, message: "Driver not found." });
  const actor = req.auth.admin.name || req.auth.admin.username;
  if (approved) {
    driver.approvalStatus = 'approved';
    driver.approvedAt = new Date().toISOString();
    driver.approvedBy = actor;
    driver.isActive = true;
    // Record push notification pending flag so driver gets notified on next login
    driver.approvalNotified = false;
    logAction("DRIVER_APPROVED", actor, driver.id, { name: driver.name, reason: reason || null }, req);
  } else {
    driver.approvalStatus = 'rejected';
    driver.rejectedAt = new Date().toISOString();
    driver.rejectedBy = actor;
    driver.rejectionReason = cleanString(reason || 'Not approved', 300);
    driver.isActive = false;
    logAction("DRIVER_REJECTED", actor, driver.id, { name: driver.name, reason: reason || null }, req);
  }
  saveDatabase(db);
  res.json({
    success: true,
    message: approved ? `${driver.name} approved and can now log in.` : `${driver.name} has been rejected.`,
    driver: publicDriver(driver)
  });
});

// Remove / deactivate inactive drivers
app.delete('/api/drivers/:id', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const idx = db.drivers.findIndex(d => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: "Driver not found." });
  const driver = db.drivers[idx];
  const actor = req.auth.admin.name || req.auth.admin.username;
  logAction("DRIVER_REMOVED", actor, driver.id, { name: driver.name }, req);
  db.drivers.splice(idx, 1);
  saveDatabase(db);
  res.json({ success: true, message: `${driver.name} has been removed from the system.` });
});

// Toggle driver active/inactive
app.patch('/api/drivers/:id/toggle', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const driver = db.drivers.find(d => d.id === req.params.id);
  if (!driver) return res.status(404).json({ success: false, message: "Driver not found." });
  driver.isActive = !driver.isActive;
  const actor = req.auth.admin.name || req.auth.admin.username;
  logAction(driver.isActive ? "DRIVER_ACTIVATED" : "DRIVER_DEACTIVATED", actor, driver.id, { name: driver.name }, req);
  saveDatabase(db);
  res.json({ success: true, isActive: driver.isActive, driver: publicDriver(driver) });
});

// Driver earnings + payout requests, calculated from real delivered orders.
// A rider earns the delivery fee recorded on each order; nothing is invented.
function driverEarningsSnapshot(driver, period) {
  const db = loadDatabase();
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const label = ['week', 'month', 'year'].includes(period) ? period : 'week';
  const buckets = [];
  if (label === 'week') {
    start.setDate(start.getDate() - 6);
    for (let i = 0; i < 7; i++) {
      const from = new Date(start); from.setDate(start.getDate() + i);
      const to = new Date(from); to.setDate(from.getDate() + 1);
      buckets.push({ label: from.toLocaleDateString('en-GB', { weekday: 'short' }), from, to });
    }
  } else if (label === 'month') {
    start.setDate(1);
    const days = Math.max(1, Math.ceil((now - start) / 86400000) + 1);
    for (let i = 0; i < days; i++) {
      const from = new Date(start); from.setDate(start.getDate() + i);
      const to = new Date(from); to.setDate(from.getDate() + 1);
      buckets.push({ label: String(from.getDate()), from, to });
    }
  } else {
    start.setMonth(0, 1);
    for (let m = 0; m < 12; m++) {
      const from = new Date(start.getFullYear(), m, 1);
      const to = new Date(start.getFullYear(), m + 1, 1);
      buckets.push({ label: from.toLocaleDateString('en-GB', { month: 'short' }), from, to });
    }
  }

  function belongs(o) {
    if (!o.driver) return false;
    if (o.driver.id && driver.id && String(o.driver.id) === String(driver.id)) return true;
    if (o.driver.username && driver.username && String(o.driver.username).toLowerCase() === String(driver.username).toLowerCase()) return true;
    return !!(o.driver.name && driver.name && String(o.driver.name).toLowerCase() === String(driver.name).toLowerCase());
  }
  function fee(o) { return Number(o.deliveryFee) || 0; }

  const mine = db.orders.filter(belongs);
  const delivered = mine.filter(o => o.status === 'delivered');
  const weekStart = new Date(); weekStart.setHours(0, 0, 0, 0); weekStart.setDate(weekStart.getDate() - 6);

  const totalEarnings = Math.round(delivered.reduce((sum, o) => sum + fee(o), 0) * 100) / 100;
  const thisWeek = Math.round(delivered.filter(o => new Date(o.deliveredAt || o.createdAt || 0) >= weekStart).reduce((sum, o) => sum + fee(o), 0) * 100) / 100;

  // A rider can only cash out delivery fees from orders that were actually
  // delivered and have not already been requested or paid out.
  const claimed = (db.payouts || [])
    .filter(p => String(p.driverId) === String(driver.id) && ['requested', 'paid'].includes(p.status))
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const pendingPayout = Math.max(0, Math.round((totalEarnings - claimed) * 100) / 100);

  const timed = delivered.filter(o => o.createdAt && o.deliveredAt);
  const avgMinutes = timed.length
    ? Math.round(timed.reduce((sum, o) => sum + Math.max(0, (new Date(o.deliveredAt) - new Date(o.createdAt)) / 60000), 0) / timed.length)
    : null;

  const chart = buckets.map(b => {
    const from = b.from.getTime();
    const to = b.to.getTime();
    const inBucket = delivered.filter(o => {
      const t = new Date(o.deliveredAt || o.createdAt || 0).getTime();
      return t >= from && t < to;
    });
    return {
      label: b.label,
      earnings: Math.round(inBucket.reduce((sum, o) => sum + fee(o), 0) * 100) / 100,
      deliveries: inBucket.length
    };
  });

  const payouts = (db.payouts || [])
    .filter(p => String(p.driverId) === String(driver.id))
    .sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0))
    .slice(0, 20)
    .map(p => ({
      id: p.id,
      amount: Number(p.amount) || 0,
      deliveries: p.deliveries || 0,
      status: p.status || 'requested',
      method: p.method || 'Mobile Money',
      requestedAt: p.requestedAt,
      paidAt: p.paidAt || null
    }));

  const recentDeliveries = delivered
    .slice()
    .sort((a, b) => new Date(b.deliveredAt || b.createdAt || 0) - new Date(a.deliveredAt || a.createdAt || 0))
    .slice(0, 10)
    .map(o => ({
      orderId: o.id,
      customer: o.customer || '',
      createdAt: o.createdAt,
      deliveredAt: o.deliveredAt || null,
      fee: fee(o),
      total: Number(o.total) || 0,
      status: o.status
    }));

  return {
    driver: { id: driver.id, name: driver.name || driver.username, phone: driver.phone || '' },
    period: label,
    totalEarnings,
    thisWeek,
    totalDeliveries: delivered.length,
    avgPerDelivery: delivered.length ? Math.round((totalEarnings / delivered.length) * 100) / 100 : 0,
    pendingPayout,
    chart,
    payouts,
    recentDeliveries,
    metrics: {
      delivered: delivered.length,
      cancelled: mine.filter(o => o.status === 'cancelled').length,
      inProgress: mine.filter(o => !['delivered', 'cancelled'].includes(o.status)).length,
      completionRate: (delivered.length + mine.filter(o => o.status === 'cancelled').length)
        ? Math.round((delivered.length / (delivered.length + mine.filter(o => o.status === 'cancelled').length)) * 1000) / 10
        : 0,
      avgDeliveryTime: avgMinutes
    }
  };
}

app.get('/api/drivers/:id/earnings', requireRole('driver', 'admin'), (req, res) => {
  const db = loadDatabase();
  const driver = db.drivers.find(d => String(d.id) === String(req.params.id))
    || (req.auth.payload.role === 'driver' ? req.auth.driver : null);
  if (!driver) return res.status(404).json({ success: false, message: 'Driver not found.' });
  if (req.auth.payload.role === 'driver' && String(driver.id) !== String(req.auth.driver.id)) {
    return res.status(403).json({ success: false, message: 'You can only view your own earnings.' });
  }
  res.json({ success: true, ...driverEarningsSnapshot(driver, req.query.period) });
});

app.post('/api/drivers/:id/payouts', requireRole('driver', 'admin'), (req, res) => {
  const db = loadDatabase();
  const driver = db.drivers.find(d => String(d.id) === String(req.params.id));
  if (!driver) return res.status(404).json({ success: false, message: 'Driver not found.' });
  if (req.auth.payload.role === 'driver' && String(driver.id) !== String(req.auth.driver.id)) {
    return res.status(403).json({ success: false, message: 'You can only request your own payout.' });
  }
  const snapshot = driverEarningsSnapshot(driver, 'week');
  const amount = toAmount((req.body || {}).amount) || snapshot.pendingPayout;
  if (!amount || amount <= 0) {
    return res.status(400).json({ success: false, message: 'There is no pending delivery fee to request yet.' });
  }
  const existing = (db.payouts || []).find(p => String(p.driverId) === String(driver.id) && p.status === 'requested');
  if (existing) {
    return res.status(200).json({ success: true, pending: true, message: 'Your payout request is already waiting for the admin.', payout: existing });
  }
  const payout = {
    id: 'payout-' + Date.now(),
    driverId: driver.id,
    driverName: driver.name || driver.username,
    amount: Math.round(amount * 100) / 100,
    deliveries: snapshot.recentDeliveries.length,
    status: 'requested',
    method: 'Mobile Money',
    requestedAt: new Date().toISOString()
  };
  db.payouts = db.payouts || [];
  db.payouts.unshift(payout);
  saveDatabase(db);
  logAction('DRIVER_PAYOUT_REQUESTED', driver.name || driver.username, driver.id, { amount: payout.amount }, req);
  res.status(201).json({ success: true, message: 'Payout request sent to the admin.', payout });
});

// Check approval status (used by driver portal to show pending screen)
app.get('/api/drivers/:id/approval', (req, res) => {
  const db = loadDatabase();
  const driver = db.drivers.find(d => d.id === req.params.id);
  if (!driver) return res.status(404).json({ success: false, message: "Driver not found." });
  // Mark notified so next poll stops showing the push banner
  let justApproved = false;
  if (driver.approvalStatus === 'approved' && driver.approvalNotified === false) {
    driver.approvalNotified = true;
    justApproved = true;
    saveDatabase(db);
  }
  res.json({
    success: true,
    approvalStatus: driver.approvalStatus || 'pending',
    justApproved,
    name: driver.name || `${driver.fname} ${driver.lname}`.trim()
  });
});

// ==========================================================
// 9. ADMIN SETTINGS — Change username / password
// ==========================================================

app.post('/api/admin/settings/credentials', requireRole('admin'), (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body || {};
  const db = loadDatabase();
  const admin = db.admins.find(a => a.id === req.auth.admin.id);
  if (!admin) return res.status(404).json({ success: false, message: "Admin account not found." });

  if (!verifyPassword(String(currentPassword || ''), admin.password)) {
    rateFail(req, 'admin', admin.username);
    logAction("ADMIN_CRED_CHANGE_FAILED", admin.username, "SETTINGS", { reason: "Wrong current password" }, req);
    return res.status(401).json({ success: false, message: "Current password is incorrect." });
  }

  let changed = [];
  if (newUsername && cleanString(newUsername, 80).toLowerCase() !== admin.username.toLowerCase()) {
    const nu = cleanString(newUsername, 80);
    if (db.admins.some(a => a.id !== admin.id && String(a.username).toLowerCase() === nu.toLowerCase())) {
      return res.status(409).json({ success: false, message: "That username is already taken." });
    }
    admin.username = nu;
    changed.push('username');
  }
  if (newPassword) {
    if (String(newPassword).length < 8) {
      return res.status(400).json({ success: false, message: "New password must be at least 8 characters." });
    }
    admin.password = hashPassword(String(newPassword));
    admin.passwordUpdatedAt = new Date().toISOString();
    changed.push('password');
  }

  if (!changed.length) return res.status(400).json({ success: false, message: "No changes provided." });

  saveDatabase(db);
  logAction("ADMIN_CREDENTIALS_UPDATED", admin.username, "SETTINGS", { changed }, req);

  const token = createToken(admin.id, 'admin', { username: admin.username, name: admin.name });
  res.json({
    success: true,
    message: `Updated: ${changed.join(' and ')}. Please use your new credentials next time.`,
    token,
    admin: { id: admin.id, username: admin.username, name: admin.name, role: admin.role }
  });
});

// ==========================================================
// 10. CUSTOMER ORDER EDIT
// ==========================================================

app.patch('/api/orders/:id/edit', (req, res) => {
  const db = loadDatabase();
  const id = normalizeOrderId(req.params.id);
  const order = db.orders.find(o => String(o.id).toUpperCase() === id);
  if (!order) return res.status(404).json({ success: false, message: "Order not found." });

  // Only allow edits on pending or kitchen orders (not enroute/arrived/delivered)
  if (['enroute', 'arrived', 'delivered', 'cancelled'].includes(order.status)) {
    return res.status(409).json({ success: false, message: "This order is already being delivered and cannot be edited. Call the rider directly." });
  }

  // Verify ownership via phone (last 9 digits match)
  const reqPhone = cleanString((req.body || {}).phone || '', 30).replace(/\s+/g, '');
  const orderPhone = String(order.phone || '').replace(/\s+/g, '');
  if (reqPhone && orderPhone && !orderPhone.endsWith(reqPhone.slice(-9))) {
    return res.status(403).json({ success: false, message: "Phone number does not match this order." });
  }

  const body = req.body || {};
  const updates = [];
  if (body.location && cleanString(body.location, 200) !== order.location) {
    order.location = cleanString(body.location, 200);
    updates.push('location');
  }
  if (body.mapPin && Number.isFinite(Number(body.mapPin.lat)) && Number.isFinite(Number(body.mapPin.lng))) {
    order.mapPin = { lat: Number(body.mapPin.lat), lng: Number(body.mapPin.lng) };
    updates.push('mapPin');
  }
  if (body.notes !== undefined) { order.notes = cleanString(body.notes, 500); updates.push('notes'); }
  if (body.timing) { order.timing = cleanString(body.timing, 60); updates.push('timing'); }

  if (body.items && Array.isArray(body.items) && body.items.length > 0) {
    const items = body.items.slice(0, 30).map(item => {
      const menuItem = (db.menuItems || []).find(m => String(m.id) === String(item.menuId));
      const unit = menuItem ? Number(menuItem.price) : toAmount(item.price);
      const qty = Math.max(1, Math.min(50, Math.floor(Number(item.quantity) || 1)));
      return {
        name: cleanString(item.name || (menuItem && menuItem.name), 100),
        noodle: cleanString(item.noodle, 60),
        menuId: menuItem ? menuItem.id : (item.menuId || null),
        price: unit || 0,
        quantity: qty,
        image: cleanString(item.image, 120)
      };
    }).filter(i => i.name && i.price >= 0);
    if (items.length > 0) {
      order.items = items;
      order.subtotal = Math.round(items.reduce((s, i) => s + i.price * i.quantity, 0) * 100) / 100;
      order.total = Math.round((order.subtotal + (order.deliveryFee || 0)) * 100) / 100;
      updates.push('items');
    }
  }

  if (!updates.length) return res.status(400).json({ success: false, message: "No valid changes provided." });

  order.lastEditedAt = new Date().toISOString();
  saveDatabase(db);
  logAction("ORDER_EDITED_BY_CUSTOMER", order.customer, order.id, { updates }, req);

  res.json({
    success: true,
    message: `Order ${order.id} updated (${updates.join(', ')}).`,
    order: projectOrder(order, 'public')
  });
});

// ==========================================================
// 11. DAILY AUDIT / CLOSE-OF-DAY REPORT
// ==========================================================

function buildDailyReport(date) {
  const db = loadDatabase();
  const dayStart = date ? new Date(date + 'T00:00:00.000Z') : (() => {
    const d = new Date(); d.setHours(0,0,0,0); return d;
  })();
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const todayOrders = db.orders.filter(o => {
    const t = new Date(o.createdAt || 0).getTime();
    return t >= dayStart.getTime() && t < dayEnd.getTime();
  });

  const delivered = todayOrders.filter(o => o.status === 'delivered');
  const cancelled = todayOrders.filter(o => o.status === 'cancelled');
  const pending = todayOrders.filter(o => !['delivered','cancelled'].includes(o.status));
  const totalIncome = todayOrders.filter(o => o.paymentStatus === 'paid').reduce((s, o) => s + (o.total || 0), 0);
  const momoIncome = todayOrders.filter(o => o.paymentStatus === 'paid' && o.paymentMode === 'momo').reduce((s, o) => s + (o.total || 0), 0);
  const cashIncome = todayOrders.filter(o => o.paymentStatus === 'paid' && o.paymentMode === 'cash').reduce((s, o) => s + (o.total || 0), 0);

  const todayLogs = (db.auditLogs || []).filter(l => {
    const t = new Date(l.timestamp || 0).getTime();
    return t >= dayStart.getTime() && t < dayEnd.getTime();
  });

  return {
    reportDate: dayStart.toISOString().split('T')[0],
    generatedAt: new Date().toISOString(),
    summary: {
      totalOrders: todayOrders.length,
      delivered: delivered.length,
      cancelled: cancelled.length,
      pending: pending.length,
      totalIncome: Math.round(totalIncome * 100) / 100,
      momoIncome: Math.round(momoIncome * 100) / 100,
      cashIncome: Math.round(cashIncome * 100) / 100,
      unpaidOrders: todayOrders.filter(o => o.paymentStatus !== 'paid').length
    },
    orders: todayOrders.map(o => ({
      id: o.id, pin: o.pickupPin, customer: o.customer, phone: o.phone,
      items: (o.items || []).map(i => `${i.quantity}x ${i.name}`).join('; '),
      total: o.total, paymentStatus: o.paymentStatus, paymentMode: o.paymentMode,
      status: o.status, createdAt: o.createdAt, deliveredAt: o.deliveredAt || '',
      driver: o.driver ? o.driver.name : ''
    })),
    activityLog: todayLogs
  };
}

app.get('/api/reports/daily', requireRole('admin'), (req, res) => {
  const report = buildDailyReport(req.query.date);
  res.json({ success: true, report });
});

// ==========================================================
// 10b. CUSTOMER REVIEWS & LOYALTY (real orders only)
// ==========================================================

function phoneKey(value) {
  return String(value || '').replace(/\D/g, '').slice(-9);
}

function ordersForPhone(db, phone) {
  const key = phoneKey(phone);
  if (!key) return [];
  return (db.orders || []).filter(o => phoneKey(o.phone) === key);
}

function publicReview(review) {
  return {
    id: review.id,
    orderId: review.orderId,
    customer: review.customer || 'Customer',
    rating: Number(review.rating) || 0,
    comment: review.comment || '',
    createdAt: review.createdAt,
    reply: review.reply || null,
    repliedAt: review.repliedAt || null
  };
}

app.get('/api/reviews', (req, res) => {
  const db = loadDatabase();
  const orderId = normalizeOrderId(req.query.orderId || '');
  const phone = phoneKey(req.query.phone);
  let reviews = (db.reviews || []).filter(r => r.hidden !== true);
  if (orderId) reviews = reviews.filter(r => String(r.orderId).toUpperCase() === orderId);
  if (phone) reviews = reviews.filter(r => phoneKey(r.phone) === phone);
  reviews = reviews
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 50);
  const average = reviews.length ? Math.round((reviews.reduce((sum, r) => sum + (Number(r.rating) || 0), 0) / reviews.length) * 10) / 10 : 0;
  res.json({ success: true, average, count: reviews.length, reviews: reviews.map(publicReview) });
});

app.post('/api/reviews', (req, res) => {
  const body = req.body || {};
  const db = loadDatabase();
  const orderId = normalizeOrderId(body.orderId || '');
  const rating = Math.max(1, Math.min(5, Math.round(Number(body.rating) || 0)));
  const comment = cleanString(body.comment, 500);
  const phone = phoneKey(body.phone);

  if (!orderId) return res.status(400).json({ success: false, message: 'Choose the order you want to review.' });
  if (!rating) return res.status(400).json({ success: false, message: 'Choose a rating from 1 to 5 stars.' });
  const order = db.orders.find(o => String(o.id).toUpperCase() === orderId);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  if (phone && phoneKey(order.phone) !== phone) {
    return res.status(403).json({ success: false, message: 'That order belongs to a different phone number.' });
  }
  if (order.status !== 'delivered') {
    return res.status(400).json({ success: false, message: 'You can review an order once it has been delivered.' });
  }

  db.reviews = db.reviews || [];
  let review = db.reviews.find(r => String(r.orderId).toUpperCase() === orderId && (!phone || phoneKey(r.phone) === phone));
  if (review) {
    review.rating = rating;
    review.comment = comment;
    review.createdAt = new Date().toISOString();
  } else {
    review = {
      id: 'rev-' + Date.now(),
      orderId,
      phone: order.phone || '',
      customer: order.customer || 'Customer',
      rating,
      comment,
      createdAt: new Date().toISOString(),
      reply: null,
      repliedAt: null
    };
    db.reviews.unshift(review);
  }
  saveDatabase(db);
  logAction('CUSTOMER_REVIEW_SAVED', order.customer || 'CUSTOMER', orderId, { rating }, req);
  res.status(201).json({ success: true, message: 'Thank you - your review is saved.', review: publicReview(review) });
});

app.post('/api/reviews/:id/reply', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const review = (db.reviews || []).find(r => String(r.id) === String(req.params.id));
  if (!review) return res.status(404).json({ success: false, message: 'Review not found.' });
  const reply = cleanString((req.body || {}).reply, 500);
  if (!reply) return res.status(400).json({ success: false, message: 'Write a reply first.' });
  review.reply = reply;
  review.repliedAt = new Date().toISOString();
  review.repliedBy = req.auth.admin.username;
  saveDatabase(db);
  logAction('REVIEW_REPLIED', req.auth.admin.username, review.orderId, { reviewId: review.id }, req);
  res.json({ success: true, review: publicReview(review) });
});

app.get('/api/loyalty/summary', (req, res) => {
  const db = loadDatabase();
  const phone = phoneKey(req.query.phone);
  if (!phone) return res.status(400).json({ success: false, message: 'Enter the phone number used for your orders.' });
  const orders = ordersForPhone(db, phone);
  const paid = orders.filter(o => o.paymentStatus === 'paid');
  const spent = paid.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
  const points = Math.floor(spent);
  const tiers = [
    { name: 'Bronze', min: 0 },
    { name: 'Silver', min: 100 },
    { name: 'Gold', min: 300 },
    { name: 'Platinum', min: 700 }
  ];
  const tier = tiers.slice().reverse().find(t => points >= t.min) || tiers[0];
  const next = tiers.find(t => t.min > points) || null;
  const myReviews = (db.reviews || []).filter(r => phoneKey(r.phone) === phone);
  res.json({
    success: true,
    phone,
    points,
    tier: tier.name,
    nextTier: next ? next.name : null,
    pointsToNext: next ? Math.max(0, next.min - points) : 0,
    orders: orders.length,
    paidOrders: paid.length,
    spent: Math.round(spent * 100) / 100,
    reviews: myReviews.length,
    tiers
  });
});

app.get('/api/customers/orders', (req, res) => {
  const db = loadDatabase();
  const orders = ordersForPhone(db, req.query.phone)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json({ success: true, orders: orders.map(o => projectOrder(o, 'public')) });
});

// ==========================================================
// 11b. BUSINESS ANALYTICS (computed from the real database)
// ==========================================================

function analyticsRangeBounds(rangeValue) {
  const range = ['today', 'week', 'month', 'year'].includes(rangeValue) ? rangeValue : 'week';
  const end = new Date();
  const start = new Date(end);
  start.setHours(0, 0, 0, 0);
  if (range === 'week') start.setDate(start.getDate() - 6);
  if (range === 'month') start.setDate(1);
  if (range === 'year') start.setMonth(0, 1);
  const span = Math.max(1, end.getTime() - start.getTime());
  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(start.getTime() - span);
  return { range, start, end, prevStart, prevEnd };
}

function analyticsInRange(orders, start, end) {
  const from = start.getTime();
  const to = end.getTime();
  return (orders || []).filter(o => {
    const t = new Date(o.createdAt || 0).getTime();
    return Number.isFinite(t) && t >= from && t <= to;
  });
}

function analyticsSummary(orders) {
  const real = orders.filter(o => o.status !== 'cancelled');
  const paid = real.filter(o => o.paymentStatus === 'paid');
  const collected = paid.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
  const orderValue = real.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
  // Total revenue is the value of every non-cancelled order, so it always
  // reconciles with orders x AOV. Money actually received is collected.
  const revenue = orderValue;
  const delivered = orders.filter(o => o.status === 'delivered').length;
  const cancelled = orders.filter(o => o.status === 'cancelled').length;
  const pending = orders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length;
  const customers = new Set(real.map(o => String(o.phone || o.customer || '').replace(/\s+/g, '')).filter(Boolean)).size;
  return {
    revenue: Math.round(revenue * 100) / 100,
    collected: Math.round(collected * 100) / 100,
    orders: orders.length,
    customers,
    aov: real.length ? Math.round((orderValue / real.length) * 100) / 100 : 0,
    delivered,
    cancelled,
    pending,
    paidOrders: paid.length,
    unpaidOrders: real.length - paid.length,
    completionRate: (delivered + cancelled) ? Math.round((delivered / (delivered + cancelled)) * 1000) / 10 : 0
  };
}

function pctChange(current, previous) {
  if (!previous) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function analyticsBuckets(bounds) {
  const { range, start, end } = bounds;
  const buckets = [];
  if (range === 'today') {
    for (let h = 0; h < 24; h++) {
      const from = new Date(start); from.setHours(h, 0, 0, 0);
      const to = new Date(from); to.setHours(h + 1, 0, 0, 0);
      buckets.push({ label: String(h).padStart(2, '0') + ':00', from, to });
    }
  } else if (range === 'week') {
    for (let i = 0; i < 7; i++) {
      const from = new Date(start); from.setDate(start.getDate() + i);
      const to = new Date(from); to.setDate(from.getDate() + 1);
      buckets.push({ label: from.toLocaleDateString('en-GB', { weekday: 'short' }), from, to });
    }
  } else if (range === 'month') {
    const days = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
    for (let i = 0; i < days; i++) {
      const from = new Date(start); from.setDate(start.getDate() + i);
      const to = new Date(from); to.setDate(from.getDate() + 1);
      buckets.push({ label: String(from.getDate()), from, to });
    }
  } else {
    for (let m = 0; m < 12; m++) {
      const from = new Date(start.getFullYear(), m, 1);
      const to = new Date(start.getFullYear(), m + 1, 1);
      buckets.push({ label: from.toLocaleDateString('en-GB', { month: 'short' }), from, to });
    }
  }
  return buckets;
}

app.get('/api/analytics/dashboard', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const bounds = analyticsRangeBounds(req.query.range);
  const orders = analyticsInRange(db.orders, bounds.start, bounds.end);
  const prevOrders = analyticsInRange(db.orders, bounds.prevStart, bounds.prevEnd);

  const kpis = analyticsSummary(orders);
  const prev = analyticsSummary(prevOrders);

  // Revenue + order series in the selected range.
  const series = analyticsBuckets(bounds).map(b => {
    const from = b.from.getTime();
    const to = b.to.getTime();
    const inBucket = orders.filter(o => {
      const t = new Date(o.createdAt || 0).getTime();
      return t >= from && t < to;
    });
    return {
      label: b.label,
      revenue: Math.round(inBucket.filter(o => o.status !== 'cancelled').reduce((sum, o) => sum + (Number(o.total) || 0), 0) * 100) / 100,
      orders: inBucket.length
    };
  });

  // Order status breakdown.
  const statusOrder = ['pending', 'kitchen', 'enroute', 'arrived', 'delivered', 'cancelled'];
  const statusBreakdown = statusOrder.map(status => ({
    status,
    label: status === 'enroute' ? 'En route' : status.charAt(0).toUpperCase() + status.slice(1),
    count: orders.filter(o => (o.status || 'pending') === status).length
  }));

  // Best selling menu items by quantity and revenue.
  const itemMap = new Map();
  orders.filter(o => o.status !== 'cancelled').forEach(o => {
    (o.items || []).forEach(item => {
      const name = item.name || 'Menu item';
      const entry = itemMap.get(name) || { name, quantity: 0, revenue: 0 };
      entry.quantity += Number(item.quantity) || 0;
      entry.revenue += (Number(item.price) || 0) * (Number(item.quantity) || 0);
      itemMap.set(name, entry);
    });
  });
  const topItems = Array.from(itemMap.values())
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 5)
    .map(i => ({ name: i.name, quantity: i.quantity, revenue: Math.round(i.revenue * 100) / 100 }));

  // Peak ordering hours (Ghana is UTC+0, matching the default server clock).
  const peakBuckets = [
    { label: '6-8 AM', from: 6, to: 9 },
    { label: '9-11 AM', from: 9, to: 12 },
    { label: '12-2 PM', from: 12, to: 15 },
    { label: '3-5 PM', from: 15, to: 18 },
    { label: '6-8 PM', from: 18, to: 21 },
    { label: '9-11 PM', from: 21, to: 24 }
  ];
  const peakHours = peakBuckets.map(b => ({
    label: b.label,
    orders: orders.filter(o => {
      const h = new Date(o.createdAt || 0).getHours();
      return h >= b.from && h < b.to;
    }).length
  }));

  // Driver performance from real delivered orders only.
  const driverMap = new Map();
  orders.forEach(o => {
    if (!o.driver || !o.driver.name) return;
    const name = o.driver.name;
    const entry = driverMap.get(name) || {
      name,
      deliveries: 0,
      active: 0,
      deliveryValue: 0,
      totalMinutes: 0,
      timedDeliveries: 0
    };
    if (o.status === 'delivered') {
      entry.deliveries += 1;
      entry.deliveryValue += Number(o.total) || 0;
      if (o.createdAt && o.deliveredAt) {
        const mins = (new Date(o.deliveredAt).getTime() - new Date(o.createdAt).getTime()) / 60000;
        if (Number.isFinite(mins) && mins >= 0) {
          entry.totalMinutes += mins;
          entry.timedDeliveries += 1;
        }
      }
    } else if (!['cancelled'].includes(o.status)) {
      entry.active += 1;
    }
    driverMap.set(name, entry);
  });
  const driverPerformance = Array.from(driverMap.values())
    .map(d => ({
      name: d.name,
      deliveries: d.deliveries,
      active: d.active,
      deliveryValue: Math.round(d.deliveryValue * 100) / 100,
      avgMinutes: d.timedDeliveries ? Math.round(d.totalMinutes / d.timedDeliveries) : null
    }))
    .sort((a, b) => b.deliveries - a.deliveries);

  // Insights are derived from the same numbers - never invented.
  const insights = [];
  if (topItems.length) {
    const best = topItems[0];
    const totalQty = topItems.reduce((sum, i) => sum + i.quantity, 0);
    insights.push({
      title: 'Best seller',
      text: best.name + ' leads with ' + best.quantity + ' portions' +
        (totalQty ? ' (' + Math.round((best.quantity / totalQty) * 100) + '% of top-item sales)' : '') +
        ' and GH₵' + best.revenue.toFixed(2) + ' in item revenue this period.'
    });
  }
  const peak = peakHours.reduce((best, b) => b.orders > best.orders ? b : best, peakHours[0]);
  if (peak && peak.orders > 0) {
    insights.push({
      title: 'Busiest window',
      text: peak.label + ' is your busiest window with ' + peak.orders + ' order' + (peak.orders === 1 ? '' : 's') + '. Staff and prep for that window first.'
    });
  }
  const repeatRows = new Map();
  orders.filter(o => o.status !== 'cancelled').forEach(o => {
    const key = String(o.phone || o.customer || '').replace(/\s+/g, '');
    if (!key) return;
    repeatRows.set(key, (repeatRows.get(key) || 0) + 1);
  });
  const repeatCustomers = Array.from(repeatRows.values()).filter(n => n > 1).length;
  const uniqueCustomers = repeatRows.size;
  if (uniqueCustomers) {
    insights.push({
      title: 'Customer retention',
      text: repeatCustomers + ' of ' + uniqueCustomers + ' customers ordered more than once this period (' +
        Math.round((repeatCustomers / uniqueCustomers) * 100) + '%). ' +
        (repeatCustomers ? 'Keep the repeat buyers close with a thank-you message.' : 'A small follow-up offer can turn first orders into repeat orders.')
    });
  }
  if (!orders.length) {
    insights.push({
      title: 'No orders yet',
      text: 'There are no orders in this period. Analytics update automatically as soon as customers order.'
    });
  }

  const recentOrders = orders
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 10)
    .map(o => ({
      orderId: o.id,
      customer: o.customer || '',
      items: (o.items || []).reduce((n, i) => n + (Number(i.quantity) || 0), 0),
      itemsLabel: (o.items || []).map(i => i.quantity + 'x ' + i.name).join(', '),
      amount: Number(o.total) || 0,
      status: o.status || 'pending',
      paymentStatus: o.paymentStatus || 'unpaid',
      driver: o.driver && o.driver.name ? o.driver.name : 'Not assigned',
      time: o.createdAt || ''
    }));

  res.json({
    success: true,
    range: bounds.range,
    generatedAt: new Date().toISOString(),
    rangeStart: bounds.start.toISOString(),
    rangeEnd: bounds.end.toISOString(),
    kpis,
    changes: {
      revenue: pctChange(kpis.revenue, prev.revenue),
      orders: pctChange(kpis.orders, prev.orders),
      customers: pctChange(kpis.customers, prev.customers),
      aov: pctChange(kpis.aov, prev.aov)
    },
    previous: prev,
    series,
    statusBreakdown,
    topItems,
    peakHours,
    driverPerformance,
    recentOrders,
    insights
  });
});

// Close-of-day: auto-trigger audit when shop closes (called by admin or cron)
app.post('/api/reports/close-of-day', requireRole('admin'), (req, res) => {
  const report = buildDailyReport(req.body && req.body.date);
  const actor = req.auth.admin.name || req.auth.admin.username;
  logAction("CLOSE_OF_DAY_AUDIT", actor, "DAILY_REPORT", {
    date: report.reportDate,
    totalOrders: report.summary.totalOrders,
    delivered: report.summary.delivered,
    income: report.summary.totalIncome
  }, req);
  res.json({ success: true, report });
});

// CSV export of daily report
app.get('/api/reports/daily/csv', requireRole('admin'), (req, res) => {
  const report = buildDailyReport(req.query.date);
  const headers = ['Order ID','PIN','Customer','Phone','Items','Total (GH₵)','Payment','Payment Status','Order Status','Created At','Delivered At','Driver'];
  const rows = report.orders.map(o => [
    o.id, o.pin, o.customer, o.phone, `"${o.items}"`,
    o.total, o.paymentMode, o.paymentStatus, o.status,
    o.createdAt, o.deliveredAt, o.driver
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="yebs-report-${report.reportDate}.csv"`);
  res.send(csv);
});

// Purge test / inactive drivers (admin utility)
app.post('/api/drivers/purge-inactive', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const { driverIds } = req.body || {};
  const actor = req.auth.admin.name || req.auth.admin.username;
  let removed = 0;
  if (Array.isArray(driverIds) && driverIds.length > 0) {
    const before = db.drivers.length;
    db.drivers = db.drivers.filter(d => !driverIds.includes(d.id));
    removed = before - db.drivers.length;
  }
  saveDatabase(db);
  logAction("DRIVERS_PURGED", actor, "DRIVERS", { removed, ids: driverIds }, req);
  res.json({ success: true, message: `${removed} driver(s) removed.`, remaining: db.drivers.length });
});

// ==========================================================
// 12. PUSH NOTIFICATION ENDPOINT (web-push compatible stub)
// Sends server-side event — clients poll /api/drivers/:id/approval
// ==========================================================

// Server-Sent Events stream for real-time push (no external service needed)
const sseClients = new Map(); // driverId -> res

app.get('/api/sse/driver/:id', (req, res) => {
  const driverId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.set(driverId, res);
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

  req.on('close', () => { sseClients.delete(driverId); });
});

function pushToDriver(driverId, payload) {
  const client = sseClients.get(driverId);
  if (client) client.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// Admin: read/update the merchant wallet every payment settles into.
app.get('/api/admin/settings/momo', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  res.json({ success: true, momo: getMomoSettings(db) });
});

app.put('/api/admin/settings/momo', requireRole('admin'), (req, res) => {
  const body = req.body || {};
  const payTo = walletPhone(body.payTo);
  if (!payTo) {
    return res.status(400).json({ success: false, message: "Enter a valid Ghanaian mobile money number (e.g. 0559103452)." });
  }
  const accountName = String(body.accountName || '').trim().slice(0, 80);
  if (!accountName) {
    return res.status(400).json({ success: false, message: "Enter the mobile money account name." });
  }
  const db = loadDatabase();
  db.settings = db.settings || {};
  db.settings.momo = { payTo, accountName };
  saveDatabase(db);
  logAction("MOMO_SETTINGS_UPDATED", req.auth.admin.username, "SETTINGS", { payTo, accountName }, req);
  res.json({ success: true, momo: getMomoSettings(db) });
});

// Admin: driver payout requests created from the driver earnings page.
app.get('/api/admin/payouts', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const payouts = (db.payouts || [])
    .slice()
    .sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));
  res.json({ success: true, payouts });
});

app.post('/api/admin/payouts/:id/pay', requireRole('admin'), (req, res) => {
  const db = loadDatabase();
  const payout = (db.payouts || []).find(p => String(p.id) === String(req.params.id));
  if (!payout) return res.status(404).json({ success: false, message: 'Payout request not found.' });
  payout.status = 'paid';
  payout.paidAt = new Date().toISOString();
  payout.paidBy = req.auth.admin.username;
  saveDatabase(db);
  logAction('DRIVER_PAYOUT_PAID', req.auth.admin.username, payout.driverId, { amount: payout.amount }, req);
  res.json({ success: true, message: 'Payout marked as paid.', payout });
});

// Health check used by the portals to detect a live API server
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: "YEBS Noodles API",
    time: new Date().toISOString(),
    storage: store.status(),
    momo: {
      payTo: getMomoSettings(loadDatabase()).payTo,
      accountName: getMomoSettings(loadDatabase()).accountName,
      apiConfigured: momoApiConfig().configured,
      networks: listMomoNetworks().map(n => ({ id: n.id, ussd: n.ussd, apiReady: n.apiReady }))
    }
  });
});

// Friendly JSON error handler (e.g. oversized photo / receipt payload)
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({
      success: false,
      message: "Uploaded image is too large. Please retake a smaller photo (under 10 MB)."
    });
  }
  console.error("API error:", err);
  res.status(500).json({ success: false, message: err && err.message ? err.message : "Server error" });
});

// Boot: load persisted state (Supabase in production, database.json locally),
// ensure the built-in administrator exists, then upgrade legacy password hashes.
let startPromise = null;
function start() {
  if (!startPromise) {
    startPromise = (async () => {
      const data = await store.init(loadDatabase);
      if (ensureSystemAccounts(data)) {
        store.set(data);
        try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); } catch (e) { /* read-only fs */ }
      }
      migratePasswords();
      return data;
    })().catch(err => {
      startPromise = null;
      throw err;
    });
  }
  return startPromise;
}

if (require.main === module) {
  start()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`YEBS Noodles API Server running at http://localhost:${PORT}`);
        console.log(`Storage: ${store.status()}`);
        console.log(`Security: bcrypt passwords - HMAC signed sessions (${SESSION_TTL_MS / 3600000}h) - login rate limiting`);
      });
    })
    .catch(err => {
      console.error('Failed to start YEBS Noodles API:', err.message);
      process.exit(1);
    });
}

module.exports = { app, start, loadDatabase, saveDatabase };
