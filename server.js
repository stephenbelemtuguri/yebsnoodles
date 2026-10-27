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
function ensureSystemAccounts(db) {
  const collections = ['admins', 'drivers', 'orders', 'sessions', 'auditLogs', 'menuItems'];
  let changed = false;

  collections.forEach(key => {
    if (!Array.isArray(db[key])) { db[key] = []; changed = true; }
  });

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
      drivers: [
        {
          id: "drv-1",
          username: "kwamemensah",
          password: hashPassword("driver@123"),
          fname: "Kwame",
          lname: "Mensah",
          name: "Kwame Mensah",
          phone: "024 456 7890",
          vehicle: "Royal 125 Motorcycle (GN-4819-24)",
          isActive: true,
          approvalStatus: "approved",
          approvedAt: new Date().toISOString(),
          approvedBy: "SYSTEM",
          approvalNotified: true,
          lat: 5.56246,
          lng: -0.21289,
          speedKmh: 0,
          createdAt: new Date().toISOString()
        },
        {
          id: "drv-2",
          username: "kofiowusu",
          password: hashPassword("driver@123"),
          fname: "Kofi",
          lname: "Owusu",
          name: "Kofi Owusu",
          phone: "055 789 1234",
          vehicle: "Boxer 150 Bike (GE-9021-23)",
          isActive: true,
          approvalStatus: "approved",
          approvedAt: new Date().toISOString(),
          approvedBy: "SYSTEM",
          approvalNotified: true,
          lat: 5.56246,
          lng: -0.21289,
          speedKmh: 0,
          createdAt: new Date().toISOString()
        }
      ],
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
    const fallback = { admins: [], drivers: [], orders: [], sessions: [], auditLogs: [], menuItems: [] };
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
    paymentStatus: order.paymentStatus || (order.paymentVerified ? 'paid' : 'unpaid'),
    paymentRef: order.paymentRef || order.id,
    paymentVerified: order.paymentVerified === true,
    paidAt: order.paidAt || null,
    verificationMethod: order.verificationMethod || null,
    momoAmount: order.momoAmount || null,
    momoTransactionRef: order.momoTransactionRef || null,
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
const customersRouter = require('./src/routes/customers');
const driversRouter = require('./src/routes/drivers');
const analyticsRouter = require('./src/routes/analytics');
const reviewsRouter = require('./src/routes/reviews');
const chatRouter = require('./src/routes/chat');
const inventoryRouter = require('./src/routes/inventory');
const loyaltyRouter = require('./src/routes/loyalty');
const referralsRouter = require('./src/routes/referrals');
const notificationsRouter = require('./src/routes/notifications');
const dynamicPricingRouter = require('./src/routes/dynamicPricing');
const receiptsRouter = require('./src/routes/receipts');

// Mount feature routes
app.use('/api/customers', customersRouter);
app.use('/api/drivers', driversRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/reviews', reviewsRouter);
app.use('/api/chat', chatRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/loyalty', loyaltyRouter);
app.use('/api/referrals', referralsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/pricing', dynamicPricingRouter);
app.use('/api/receipts', receiptsRouter);

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
  const payment = cleanString(body.payment || 'MTN Mobile Money', 80);
  const paymentMode = paymentModeFor(payment);

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
    mapPin: body.mapPin && Number.isFinite(Number(body.mapPin.lat)) && Number.isFinite(Number(body.mapPin.lng))
      ? { lat: Number(body.mapPin.lat), lng: Number(body.mapPin.lng) }
      : { lat: 5.5650, lng: -0.2100 },
    timing: cleanString(body.timing || "As soon as possible", 60),
    items,
    subtotal,
    deliveryFee,
    total,
    payment,
    paymentMode,
    paymentStatus: 'unpaid',
    paymentRef: id,
    paymentVerified: false,
    paidAt: null,
    verificationMethod: null,
    momoAmount: null,
    momoTransactionRef: null,
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

// Health check used by the portals to detect a live API server
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    service: "YEBS Noodles API",
    time: new Date().toISOString(),
    storage: store.status()
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
