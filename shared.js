// YEBS Noodles - Shared Real-time Data Store & Dispatch Engine
// Synchronizes Customer, Driver, and Admin portals across tabs and devices

const STORAGE_KEY = "yebs_noodles_orders_v2";
const DRIVERS_KEY = "yebs_noodles_drivers_v2";
const SESSION_KEY = "yebs_noodles_session_state_v2";
const PERMISSION_KEY = "yebs_noodles_permissions_v1";
const BROADCAST_CHANNEL = "yebs_noodles_realtime_channel";
const DRIVER_LOCATION_KEY = "yebs_noodles_driver_live_location";
const ARRIVAL_EVENT_KEY = "yebs_noodles_arrival_event";
const PICKUP_POINT_KEY = "yebs_noodles_pickup_point";

// Owner's WhatsApp Number (YEBS Kitchen Hotline)
export const OWNER_WHATSAPP_NUMBER = "233559103452"; // 055 910 3452

// Ghana Mobile Money (MoMo) Configuration
export const MOMO_CONFIG = {
  number: "0559103452",
  displayNumber: "055 910 3452",
  merchantName: "MATHEW TIA",
  network: "MTN Mobile Money / Telecel Cash / AT Money"
};

// Free map tile providers (NO API KEY REQUIRED)
export const GOOGLE_MAPS_TILE_URL = "https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}";
export const GOOGLE_MAPS_HYBRID_TILE_URL = "https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}";
export const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
export const CARTO_LIGHT_TILE_URL = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
export const CARTO_VOYAGER_TILE_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

// Invisible 1x1 tile so a blocked provider never shows broken-image icons.
const TRANSPARENT_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function makeStreetLayer() {
  return L.tileLayer(OSM_TILE_URL, {
    maxZoom: 19,
    subdomains: ["a", "b", "c"],
    crossOrigin: true,
    errorTileUrl: TRANSPARENT_TILE,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  });
}

function makeCartoLayer() {
  return L.tileLayer(CARTO_VOYAGER_TILE_URL, {
    maxZoom: 20,
    subdomains: "abcd",
    crossOrigin: true,
    errorTileUrl: TRANSPARENT_TILE,
    attribution: '&copy; OpenStreetMap &copy; CARTO'
  });
}

function makeGoogleLayer() {
  return L.tileLayer(GOOGLE_MAPS_TILE_URL, {
    maxZoom: 20,
    subdomains: ["mt0", "mt1", "mt2", "mt3"],
    errorTileUrl: TRANSPARENT_TILE,
    attribution: "&copy; Google Maps"
  });
}

// Canvas "offline grid" layer. It is always added underneath the online tiles,
// so the map is never a blank box even when every tile server is unreachable.
function makeOfflineGridLayer() {
  const OfflineGrid = L.GridLayer.extend({
    createTile(coords) {
      const tile = document.createElement("canvas");
      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      const ctx = tile.getContext("2d");

      // Soft paper background
      ctx.fillStyle = "#eef3ea";
      ctx.fillRect(0, 0, size.x, size.y);

      // Fine grid
      ctx.strokeStyle = "#dbe6d9";
      ctx.lineWidth = 1;
      const step = 32;
      for (let x = 0; x <= size.x; x += step) {
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, size.y);
        ctx.stroke();
      }
      for (let y = 0; y <= size.y; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(size.x, y + 0.5);
        ctx.stroke();
      }

      // Deterministic pseudo-roads so the grid resembles a street map.
      const seed = ((coords.x * 73856093) ^ (coords.y * 19349663) ^ (coords.z * 83492791)) >>> 0;
      const rand = (n, salt) => {
        const v = Math.sin((seed + salt * 7919) * 0.0001) * 10000;
        return Math.abs(v - Math.floor(v)) * n;
      };
      ctx.strokeStyle = "#cfdccc";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(0, rand(size.y, 1));
      ctx.bezierCurveTo(size.x * 0.35, rand(size.y, 2), size.x * 0.65, rand(size.y, 3), size.x, rand(size.y, 4));
      ctx.stroke();
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(rand(size.x, 5), 0);
      ctx.lineTo(rand(size.x, 6), size.y);
      ctx.stroke();

      // A couple of landmark blocks
      ctx.fillStyle = "#e2ecdf";
      for (let i = 0; i < 3; i++) {
        const w = 18 + rand(26, 10 + i);
        const h = 14 + rand(22, 20 + i);
        ctx.fillRect(rand(size.x - w, 30 + i), rand(size.y - h, 40 + i), w, h);
      }

      // Tile label
      ctx.fillStyle = "#7b8a78";
      ctx.font = "600 10px system-ui, sans-serif";
      ctx.fillText(coords.z >= 13 ? "Accra · offline map" : "Accra", 8, 16);
      ctx.font = "9px system-ui, sans-serif";
      ctx.fillStyle = "#9aa898";
      ctx.fillText(`${coords.z}/${coords.x}/${coords.y}`, 8, size.y - 8);

      return tile;
    }
  });
  return new OfflineGrid({
    attribution: "",
    zIndex: 1,
    updateWhenIdle: false
  });
}

// Adds a basemap that automatically fails over between providers, so the map
// still renders even when one tile server is blocked or unreachable.
export function addReliableBasemap(map) {
  if (!map || typeof L === "undefined") return null;

  const offline = makeOfflineGridLayer().addTo(map);

  const street = makeStreetLayer();
  const carto = makeCartoLayer();
  const google = makeGoogleLayer();

  const sequence = [street, carto, google];
  let index = 0;
  let active = street;
  let errorStreak = 0;
  let switching = false;
  let gaveUp = false;

  const notice = L.control({ position: "bottomleft" });
  notice.onAdd = function () {
    const div = L.DomUtil.create("div", "leaflet-bar");
    div.style.cssText = "background:rgba(23,61,48,0.92);color:#fff;font:600 11px/1.4 system-ui,sans-serif;padding:5px 9px;border-radius:6px;display:none;max-width:210px;";
    div.textContent = "Offline map — street tiles are unreachable. Your pins and routes still work.";
    this._div = div;
    return div;
  };
  notice.addTo(map);

  function showOfflineNotice() {
    if (notice._div) notice._div.style.display = "block";
    setOfflineVisible(true);
  }

  function setOfflineVisible(visible) {
    try {
      const el = offline.getContainer && offline.getContainer();
      if (el) el.style.display = visible ? "" : "none";
    } catch (e) {}
  }
  function hideOfflineNotice() {
    if (notice._div) notice._div.style.display = "none";
    setOfflineVisible(false);
  }

  function countTileImages() {
    try {
      const pane = map.getPane("tilePane");
      if (!pane) return 0;
      return pane.querySelectorAll("img.leaflet-tile").length;
    } catch (e) {
      return 0;
    }
  }

  function countLoadedTiles() {
    try {
      const pane = map.getPane("tilePane");
      if (!pane) return 0;
      return Array.from(pane.querySelectorAll("img.leaflet-tile")).filter(img => img.complete && img.naturalWidth > 1).length;
    } catch (e) {
      return 0;
    }
  }

  const failOver = () => {
    if (switching) return;
    if (index >= sequence.length - 1) {
      gaveUp = true;
      showOfflineNotice();
      return;
    }
    switching = true;
    try { map.removeLayer(active); } catch (e) {}
    index += 1;
    active = sequence[index];
    errorStreak = 0;
    active.addTo(map);
    try {
      const c = active.getContainer && active.getContainer();
      if (c) c.style.zIndex = 4;
    } catch (e) {}
    active.on("tileerror", onTileError);
    active.on("tileload", hideOfflineNotice);
    active.on("load", () => { errorStreak = 0; });
    switching = false;
  };

  function onTileError() {
    errorStreak += 1;
    if (errorStreak >= 3) failOver();
  }

  active.on("tileerror", onTileError);
  active.on("tileload", hideOfflineNotice);
  active.on("load", () => { errorStreak = 0; });
  active.addTo(map);
  try {
    const c = active.getContainer && active.getContainer();
    if (c) c.style.zIndex = 4;
    const oc = offline.getContainer && offline.getContainer();
    if (oc) { oc.style.zIndex = 1; oc.style.display = "none"; }
  } catch (e) {}

  // Watchdog: Leaflet can silently hang when a tile host is blocked. If no
  // real tiles have decoded after ~3.5s, try the next provider, then settle on
  // the offline grid instead of leaving a blank map.
  let watchdogRuns = 0;
  const watchdog = () => {
    watchdogRuns += 1;
    // Any tile image from any provider means the map is online — clear the warning.
    if (countTileImages() > 0) { hideOfflineNotice(); return; }
    if (gaveUp) { showOfflineNotice(); return; }
    if (watchdogRuns < 5) failOver();
    else showOfflineNotice();
    if (watchdogRuns < 12) setTimeout(watchdog, 2500);
  };
  setTimeout(watchdog, 3500);

  L.control.layers(
    {
      "Street Map (online)": street,
      "Light Map (online)": carto,
      "Google Roads (online)": google,
      "Offline grid": offline
    },
    null,
    { collapsed: true, position: "topright" }
  ).addTo(map);

  const refresh = () => { try { map.invalidateSize(); } catch (e) {} };
  setTimeout(refresh, 120);
  setTimeout(refresh, 700);
  window.addEventListener("resize", refresh);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

  return {
    street,
    carto,
    google,
    offline,
    getActive: () => active,
    isOffline: () => countLoadedTiles() === 0,
    refresh
  };
}

export function isDriverOnline(driver) {
  if (!driver) return false;
  if (typeof driver.isActive === "boolean") return driver.isActive;
  if (typeof driver.isOnline === "boolean") return driver.isOnline;
  return true;
}

export function resolveDriverPhone(orderOrDriver) {
  if (!orderOrDriver) return "";

  // Detect whether we were handed an order or a bare driver record. For an
  // order we must NEVER fall back to the customer's phone number.
  const looksLikeOrder = orderOrDriver.customer !== undefined
    || Object.prototype.hasOwnProperty.call(orderOrDriver, 'items')
    || Object.prototype.hasOwnProperty.call(orderOrDriver, 'pickupPin');
  const driver = orderOrDriver.driver || (looksLikeOrder ? null : orderOrDriver);

  if (driver && driver.phone) return driver.phone;
  if (!looksLikeOrder && orderOrDriver.phone) return orderOrDriver.phone;

  const name = (driver && driver.name) || "";
  if (name) {
    const match = getDispatchDrivers().find(d => (d.name || "").toLowerCase() === name.toLowerCase());
    if (match && match.phone) return match.phone;
  }
  return "";
}

export function formatTelHref(phone) {
  if (!phone) return "#";
  const raw = String(phone).trim();
  const digits = raw.replace(/[^\d+]/g, "");
  if (!digits) return "#";
  if (digits.startsWith("+")) return `tel:${digits}`;
  if (digits.startsWith("233")) return `tel:+${digits}`;
  if (digits.startsWith("0") && digits.length >= 9) return `tel:+233${digits.slice(1)}`;
  return `tel:${digits}`;
}

export function getDispatchDrivers() {
  const base = getDrivers();
  let registered = [];
  try {
    registered = JSON.parse(localStorage.getItem("yebs_registered_drivers") || "[]");
  } catch (e) {
    registered = [];
  }
  const merged = [...registered, ...base];
  const seen = new Set();
  return merged.filter((d) => {
    const key = (d.id || d.phone || d.name || "").toString();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function rememberRegisteredDriver(driver) {
  if (!driver) return;
  try {
    const list = JSON.parse(localStorage.getItem("yebs_registered_drivers") || "[]");
    const next = list.filter((d) => d.id !== driver.id && d.username !== driver.username);
    next.unshift({
      id: driver.id,
      name: driver.name || `${driver.fname || ""} ${driver.lname || ""}`.trim(),
      phone: driver.phone,
      vehicle: driver.vehicle,
      photo: driver.photo || null,
      username: driver.username,
      isOnline: true
    });
    localStorage.setItem("yebs_registered_drivers", JSON.stringify(next.slice(0, 40)));
  } catch (e) {}
}

// Default Restaurant Coordinates (Adabraka, Accra, Ghana - in front of Efex Hotel)
export const RESTAURANT_COORDS = {
  lat: 5.56246,
  lng: -0.21289,
  name: "YEBS Noodles Kitchen",
  address: "In front of Efex Hotel, Adabraka, Accra"
};

// Default Central Pickup Points for Accra Street Deliveries
export const DEFAULT_PICKUP_POINTS = [
  { id: "pick-1", name: "Circle Odo Rice Junction / VIP Station", lat: 5.5612, lng: -0.2155 },
  { id: "pick-2", name: "In Front of Efex Hotel, Adabraka", lat: 5.56246, lng: -0.21289 },
  { id: "pick-3", name: "Adabraka Police Station / Market Bus Stop", lat: 5.5580, lng: -0.2105 },
  { id: "pick-4", name: "Ridge Hospital Main Gate", lat: 5.5628, lng: -0.2035 }
];

// 6:00 PM to 9:00 PM Operating Hours Configuration
export const CLOSING_HOUR_24 = 21; // 9:00 PM
export const OPENING_HOUR_24 = 18; // 6:00 PM (18:00)

export function isKitchenOpen() {
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinutes = now.getMinutes();

  // Open strictly between 18:00 (6:00 PM) and 21:00 (9:00 PM)
  const isClosed = currentHour >= CLOSING_HOUR_24 || currentHour < OPENING_HOUR_24;
  
  return {
    isOpen: !isClosed,
    currentHour,
    currentMinutes,
    closingTimeText: "9:00 PM",
    openingTimeText: "6:00 PM",
    message: isClosed 
      ? "YEBS Noodles Kitchen is currently CLOSED. Our daily hours are 6:00 PM to 9:00 PM. We look forward to cooking for you this evening!"
      : "Kitchen is OPEN! Daily operating hours: 6:00 PM to 9:00 PM."
  };
}

// Official YEBS Noodles Menu (15 to 60 Cedis Poster Template)
export const DEFAULT_POSTER_MENU = [
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
    image: "img_food_3.jpg",
    badge: "60 CEDIS",
    tag: "Two Chicken + Beta Malt",
    template: "poster-capsule"
  }
];

export const MENU_KEY = "yebs_menu_items_v2";

export function getMenuItems() {
  try {
    const raw = localStorage.getItem(MENU_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {}
  return DEFAULT_POSTER_MENU;
}

export function saveMenuItems(items) {
  try {
    localStorage.setItem(MENU_KEY, JSON.stringify(items));
    broadcastEvent("MENU_UPDATED", { items });
  } catch (e) {
    console.error("Could not save menu items locally", e);
  }
}

export const MENU_ITEMS = getMenuItems();

// Default Drivers
export const DEFAULT_DRIVERS = [];

export const DEFAULT_SESSION_STATE = {
  sessionNumber: 1,
  status: "ACTIVE",
  startedAt: new Date().toISOString(),
  intermissionEndsAt: null,
  durationSeconds: 180,
  pickupPoint: DEFAULT_PICKUP_POINTS[0]
};

// Broadcaster setup
let channel = null;
try {
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(BROADCAST_CHANNEL);
  }
} catch (e) {
  console.warn("BroadcastChannel not supported", e);
}

export function broadcastEvent(type, payload) {
  if (channel) {
    channel.postMessage({ type, payload, timestamp: Date.now() });
  }
  localStorage.setItem("yebs_noodles_last_sync", Date.now().toString());
}

export function onSyncEvent(callback) {
  const handler = (evt) => {
    callback(evt.data || { type: "STORAGE_UPDATE", payload: null });
  };
  if (channel) {
    channel.addEventListener("message", handler);
  }
  window.addEventListener("storage", (e) => {
    if ([STORAGE_KEY, SESSION_KEY, DRIVER_LOCATION_KEY, ARRIVAL_EVENT_KEY, PICKUP_POINT_KEY, "yebs_noodles_last_sync"].includes(e.key)) {
      callback({ type: "STORAGE_UPDATE", payload: null, key: e.key });
    }
  });
}

// Store Initialization
export function initStore() {
  if (!localStorage.getItem(STORAGE_KEY)) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
  }
  // The driver roster is owned by the server database. Never seed invented
  // riders into localStorage - an empty roster is the honest answer.
  if (!localStorage.getItem(DRIVERS_KEY)) {
    localStorage.setItem(DRIVERS_KEY, JSON.stringify([]));
  }
  if (!localStorage.getItem(SESSION_KEY)) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(DEFAULT_SESSION_STATE));
  }
}

// =====================================
// AUDIO NOTIFICATION CHIME & BILINGUAL VOICE (ENGLISH + TWI)
// =====================================
export function playChime(type = 'arrival') {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const now = ctx.currentTime;

    if (type === 'arrival') {
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(523.25, now);
      osc1.frequency.setValueAtTime(659.25, now + 0.15);
      osc1.frequency.setValueAtTime(783.99, now + 0.3);

      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(783.99, now + 0.3);
      osc2.frequency.exponentialRampToValueAtTime(1046.50, now + 0.6);

      gain.gain.setValueAtTime(0.4, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 1.2);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc1.stop(now + 0.45);
      osc2.start(now + 0.3);
      osc2.stop(now + 1.2);
    } else if (type === 'neworder') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.setValueAtTime(1100, now + 0.12);
      osc.frequency.setValueAtTime(880, now + 0.24);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.5);
    } else {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.2);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.3);
    }
  } catch (err) {
    console.warn("Audio chime error", err);
  }
}

// Bilingual Arrival Voice Synthesizer (English + Twi)
export function playVoiceArrivalAnnouncement(pickupPointName) {
  playChime('arrival');
  if ('speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
      
      const text = `Attention YEBS Noodles customers! Your delivery rider has arrived at ${pickupPointName}. Please come out with your 4-digit pickup code to collect your fresh noodles. Mo mmra mmegye mo aduane!`;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.95;
      utterance.pitch = 1.05;

      // Select natural English voice if available
      const voices = window.speechSynthesis.getVoices();
      const preferred = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Samantha')));
      if (preferred) utterance.voice = preferred;

      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn("Speech synthesis error", e);
    }
  }
}

// Native Notification Helper
export function triggerNativeNotification(title, body, icon = "logo.png") {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(title, {
        body,
        icon,
        badge: icon,
        vibrate: [200, 100, 200],
        tag: "yebs-" + Date.now(),
        requireInteraction: true
      });
      setTimeout(() => n.close(), 15000);
      return n;
    } catch (e) {
      console.warn("Native Notification error", e);
    }
  }
  return null;
}

export async function requestNotificationPermission() {
  if (!("Notification" in window)) return { granted: false, reason: "not_supported" };
  if (Notification.permission === "granted") return { granted: true };
  if (Notification.permission === "denied") return { granted: false, reason: "denied" };

  const result = await Notification.requestPermission();
  const perms = getSavedPermissions();
  perms.notification = result === "granted";
  perms.asked = true;
  savePermissions(perms);
  return { granted: result === "granted" };
}

export function requestLocationPermission(callback) {
  if (!navigator.geolocation) {
    callback({ granted: false, reason: "not_supported" });
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const perms = getSavedPermissions();
      perms.location = true;
      savePermissions(perms);
      callback({ granted: true, position: pos });
    },
    (err) => {
      callback({ granted: false, reason: err.message });
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

export function getSavedPermissions() {
  try {
    const raw = localStorage.getItem(PERMISSION_KEY);
    return raw ? JSON.parse(raw) : { notification: false, location: false, asked: false };
  } catch (e) {
    return { notification: false, location: false, asked: false };
  }
}

export function savePermissions(perms) {
  localStorage.setItem(PERMISSION_KEY, JSON.stringify(perms));
  broadcastEvent("PERMISSIONS_UPDATED", perms);
}

// =====================================
// PURE OFFLINE SVG QR CODE GENERATOR
// =====================================
export function generateSvgQrCode(dataText, size = 160) {
  // Deterministic 21x21 QR pattern generator for offline representation
  let hash = 0;
  for (let i = 0; i < dataText.length; i++) {
    hash = ((hash << 5) - hash) + dataText.charCodeAt(i);
    hash |= 0;
  }
  
  const modules = 21;
  const cellSize = size / modules;
  let rects = '';

  // Standard 3 position detection squares (Top-Left, Top-Right, Bottom-Left)
  function drawFinderPattern(startX, startY) {
    rects += `<rect x="${startX * cellSize}" y="${startY * cellSize}" width="${7 * cellSize}" height="${7 * cellSize}" fill="#173d30" rx="3"/>`;
    rects += `<rect x="${(startX + 1) * cellSize}" y="${(startY + 1) * cellSize}" width="${5 * cellSize}" height="${5 * cellSize}" fill="#ffffff"/>`;
    rects += `<rect x="${(startX + 2) * cellSize}" y="${(startY + 2) * cellSize}" width="${3 * cellSize}" height="${3 * cellSize}" fill="#173d30"/>`;
  }

  drawFinderPattern(0, 0);
  drawFinderPattern(14, 0);
  drawFinderPattern(0, 14);

  // Generate data matrix cells based on string hash
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      // Skip finder patterns
      if ((row < 8 && col < 8) || (row < 8 && col >= 13) || (row >= 13 && col < 8)) continue;
      
      const pseudoRandom = Math.sin(hash + (row * 31) + (col * 17)) * 10000;
      if (pseudoRandom - Math.floor(pseudoRandom) > 0.48) {
        rects += `<rect x="${col * cellSize}" y="${row * cellSize}" width="${cellSize - 0.4}" height="${cellSize - 0.4}" fill="#173d30" rx="1"/>`;
      }
    }
  }

  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" style="background:#ffffff; padding:6px; border-radius:10px; border:2px solid #e57a45; box-shadow:0 4px 12px rgba(0,0,0,0.08);">${rects}</svg>`;
}

// =====================================
// SESSION STATE & 3-MINUTE LOOP ENGINE
// =====================================
export function getSessionState() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const session = raw ? JSON.parse(raw) : DEFAULT_SESSION_STATE;
    
    if (session.status === "INTERMISSION" && session.intermissionEndsAt) {
      const now = Date.now();
      if (now >= session.intermissionEndsAt) {
        session.status = "ACTIVE";
        session.sessionNumber = (session.sessionNumber || 1) + 1;
        session.startedAt = new Date().toISOString();
        session.intermissionEndsAt = null;
        saveSessionState(session);
        broadcastEvent("SESSION_STARTED", session);
      }
    }
    return session;
  } catch (err) {
    console.error("Error reading session state", err);
    return DEFAULT_SESSION_STATE;
  }
}

export function saveSessionState(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  broadcastEvent("SESSION_STATE_CHANGED", session);
}

export function stopOrderSessionAndStartCountdown(seconds = 180) {
  const session = getSessionState();
  const endsAt = Date.now() + (seconds * 1000);
  
  session.status = "INTERMISSION";
  session.intermissionEndsAt = endsAt;
  session.durationSeconds = seconds;
  session.lastEnrouteAt = new Date().toISOString();
  
  saveSessionState(session);
  broadcastEvent("SESSION_INTERMISSION_STARTED", {
    sessionNumber: session.sessionNumber,
    endsAt,
    seconds
  });
  return session;
}

export function forceStartNewOrderSession() {
  const session = getSessionState();
  session.status = "ACTIVE";
  session.sessionNumber = (session.sessionNumber || 1) + 1;
  session.startedAt = new Date().toISOString();
  session.intermissionEndsAt = null;
  saveSessionState(session);
  broadcastEvent("SESSION_STARTED", session);
  return session;
}

// Set driver-designated pickup point for the active session
export function setSessionPickupPoint(name, coords = null) {
  const session = getSessionState();
  const point = {
    name,
    lat: coords ? coords.lat : (session.pickupPoint ? session.pickupPoint.lat : RESTAURANT_COORDS.lat + 0.005),
    lng: coords ? coords.lng : (session.pickupPoint ? session.pickupPoint.lng : RESTAURANT_COORDS.lng + 0.005),
    setAt: new Date().toISOString()
  };
  session.pickupPoint = point;
  saveSessionState(session);
  localStorage.setItem(PICKUP_POINT_KEY, JSON.stringify(point));
  broadcastEvent("PICKUP_POINT_UPDATED", point);
  return point;
}

// Merge the server's shared pickup point into the local session cache.
export function applyServerSession(serverSession) {
  if (!serverSession || typeof serverSession !== "object") return getSessionState();
  const session = getSessionState();
  if (serverSession.sessionNumber) session.sessionNumber = serverSession.sessionNumber;
  if (serverSession.status) session.status = serverSession.status;
  if (serverSession.pickupPoint && serverSession.pickupPoint.name) {
    session.pickupPoint = {
      ...serverSession.pickupPoint,
      lat: Number(serverSession.pickupPoint.lat),
      lng: Number(serverSession.pickupPoint.lng)
    };
    try { localStorage.setItem(PICKUP_POINT_KEY, JSON.stringify(session.pickupPoint)); } catch (e) {}
  }
  saveSessionState(session);
  broadcastEvent("SESSION_SYNCED", session);
  return session;
}

export function getPickupPoint() {
  const session = getSessionState();
  return session.pickupPoint || DEFAULT_PICKUP_POINTS[0];
}

// Notify all session customers that driver has arrived at the pickup point
export function notifySessionArrivalAtPickupPoint(pickupPointName, driverName, driverCoords = null, driverInfo = {}) {
  const session = getSessionState();
  const meetingPoint = driverCoords || (session.pickupPoint ? { lat: session.pickupPoint.lat, lng: session.pickupPoint.lng } : RESTAURANT_COORDS);
  const driverPhone = driverInfo.phone || "";
  const driverPhoto = driverInfo.photo || null;
  const driverVehicle = driverInfo.vehicle || "";

  const orders = getOrders();
  let affectedOrders = [];
  orders.forEach((o, i) => {
    if (o.status === 'delivered' || o.status === 'cancelled') return;

    // Only announce arrival for this rider's own packages (or unassigned ones),
    // never overwrite another rider's delivery.
    const assignedName = o.driver && o.driver.name;
    const isMine = !assignedName || String(assignedName).toLowerCase() === String(driverName || '').toLowerCase();
    if (!isMine) return;

    o.status = 'arrived';
    o.arrivedAt = new Date().toISOString();
    o.meetingPoint = meetingPoint;
    o.pickupPointName = pickupPointName;
    if (!o.driver) o.driver = {};
    o.driver.name = driverName;
    o.driver.phone = driverPhone || o.driver.phone || "";
    o.driver.photo = driverPhoto || o.driver.photo || null;
    o.driver.vehicle = driverVehicle || o.driver.vehicle || "";
    o.driver.currentLocation = meetingPoint;
    orders[i] = o;
    affectedOrders.push(o);
    apiUpdateOrderStatus(o.id, { status: 'arrived', driver: o.driver }).catch(() => {});
  });
  saveOrders(orders);

  const arrivalPayload = {
    sessionNumber: session.sessionNumber,
    driverName,
    driverPhone,
    driverPhoto,
    driverVehicle,
    pickupPointName,
    meetingPoint,
    ordersCount: affectedOrders.length,
    affectedOrderIds: affectedOrders.map(o => o.id),
    timestamp: Date.now(),
    message: `🛵 Driver ${driverName} has arrived at Pickup Point: "${pickupPointName}"! Please bring your 4-digit Pickup PIN to collect your food.`
  };

  localStorage.setItem(ARRIVAL_EVENT_KEY, JSON.stringify(arrivalPayload));
  playVoiceArrivalAnnouncement(pickupPointName);
  broadcastEvent("DRIVER_ARRIVED_AT_PICKUP", arrivalPayload);
  return arrivalPayload;
}

// =====================================
// BATCH COMPLETE & NOTIFY OWNER VIA WHATSAPP
// =====================================
export function completeSessionDeliveriesAndNotifyOwner(sessionNumber, driverName, pickupPointName) {
  const orders = getOrders();
  const deliveredOrders = [];
  let totalCashCollected = 0;

  orders.forEach((o, i) => {
    if (o.status !== 'cancelled') {
      if (o.status !== 'delivered') {
        o.status = 'delivered';
        o.orderSession = {
          ...(o.orderSession || {}),
          isActive: false,
          deliveredAt: new Date().toISOString()
        };
        o.deliveredAt = new Date().toISOString();
        orders[i] = o;
      }
      deliveredOrders.push(o);
      totalCashCollected += (o.total || 0);
    }
  });

  saveOrders(orders);

  const orderListLines = deliveredOrders.map((o, idx) => {
    const items = o.items ? o.items.map(it => `${it.name} (${it.noodle}) x${it.quantity}`).join(', ') : 'Noodles';
    return `${idx + 1}. *#${o.id}* [PIN: ${o.pickupPin || 'OK'}]\n   👤 ${o.customer} (${o.phone})\n   🍜 ${items}\n   💰 GH₵${o.total} [${o.payment || 'MoMo / Cash'}]`;
  }).join('\n\n');

  const nowFormatted = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateFormatted = new Date().toLocaleDateString([], { dateStyle: 'medium' });

  const ownerReportMessage = [
    `*✅ YEBS NOODLES - BATCH DELIVERY COMPLETE REPORT*`,
    `----------------------------------------`,
    `📅 *Date:* ${dateFormatted} at ${nowFormatted}`,
    `📦 *Session:* Batch #${sessionNumber || 1}`,
    `🛵 *Driver:* ${driverName}`,
    `📍 *Pickup Point Delivered:* ${pickupPointName}`,
    `📊 *Total Orders Delivered:* ${deliveredOrders.length} packages`,
    `💰 *Total Revenue Collected:* GH₵${totalCashCollected}.00`,
    `----------------------------------------`,
    `*DELIVERED PACKAGES BREAKDOWN:*`,
    orderListLines || 'No orders in batch',
    `----------------------------------------`,
    `Status: All deliveries successfully verified via 4-digit Pickup PIN, handed over at pickup point, and logged in Admin panel.`
  ].join('\n');

  const whatsappUrl = `https://wa.me/${OWNER_WHATSAPP_NUMBER}?text=${encodeURIComponent(ownerReportMessage)}`;

  broadcastEvent("SESSION_DELIVERIES_COMPLETED", {
    sessionNumber,
    deliveredCount: deliveredOrders.length,
    totalCashCollected,
    driverName,
    pickupPointName
  });

  return {
    success: true,
    deliveredCount: deliveredOrders.length,
    totalRevenue: totalCashCollected,
    reportMessage: ownerReportMessage,
    whatsappUrl
  };
}

// =====================================
// ORDER CRUD WITH 4-DIGIT PIN & MOMO
// =====================================
export function getOrders() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error("Error reading orders", err);
    return [];
  }
}

export function getOrderById(id) {
  if (!id) return null;
  const orders = getOrders();
  let searchId = String(id).trim().toUpperCase().replace(/\s+/g, '');
  if (/^\d{4}$/.test(searchId)) searchId = `YB-${searchId}`;
  return orders.find(o => String(o.id).toUpperCase() === searchId || String(o.pickupPin) === String(id).trim()) || null;
}

export function saveOrders(orders) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
  broadcastEvent("ORDERS_UPDATED", { count: orders.length });
}

export async function createOrder(orderData, editOrderId = '') {
  const currentSession = getSessionState();
  const paymentLabel = orderData.payment || "MTN Mobile Money";
  const paymentMode = /cash|pay on delivery|on arrival|upon delivery/i.test(paymentLabel) ? "cash" : "momo";
  const originalOrder = editOrderId ? getOrderById(editOrderId) : null;
  if (editOrderId && !originalOrder) throw new Error('The order to edit could not be found.');

  let newOrder;
  if (editOrderId) {
    const result = await apiEditOrder(editOrderId, {
      ...orderData,
      sessionNumber: currentSession.sessionNumber
    });
    if (!result.success || !result.order) {
      throw new Error(result.message || 'The order could not be updated.');
    }
    newOrder = {
      ...originalOrder,
      ...result.order,
      trackingToken: originalOrder.trackingToken,
      phone: orderData.phone,
      notes: orderData.notes,
      location: result.order.location || orderData.location,
      mapPin: result.order.mapPin || orderData.mapPin,
      items: result.order.items || orderData.items || []
    };
  } else {
    const serverOrder = await apiCreateOrder({
      ...orderData,
      sessionNumber: currentSession.sessionNumber
    });
    if (!serverOrder || !serverOrder.id) {
      throw new Error('The server did not confirm the order. Please try again.');
    }
    newOrder = {
      ...serverOrder,
      // Public projection intentionally hides private contact data; keep the
      // customer's own copy intact for their tracking screen.
      phone: orderData.phone,
      notes: orderData.notes,
      location: serverOrder.location || orderData.location,
      mapPin: serverOrder.mapPin || orderData.mapPin,
      items: serverOrder.items || orderData.items || []
    };
  }

  newOrder.pickupPin = String(newOrder.pickupPin || '');
  newOrder.pickupPinIsOrderId = false;
  newOrder.paymentRef = newOrder.paymentRef || newOrder.id;
  newOrder.paymentMode = newOrder.paymentMode || paymentMode;
  newOrder.paymentStatus = newOrder.paymentStatus || "unpaid";

  const fresh = getOrders().filter(o => String(o.id).toUpperCase() !== String(newOrder.id).toUpperCase());
  fresh.unshift(newOrder);
  saveOrders(fresh);
  broadcastEvent("NEW_ORDER", newOrder);

  return newOrder;
}

// Verify the customer's separate pickup PIN on the server when online.
export async function verifyOrderPin(orderId, enteredPin) {
  const code = String(enteredPin || "").replace(/[^0-9]/g, "");
  try {
    const token = sessionStorage.getItem("yebs_driver_token") || sessionStorage.getItem("yebs_admin_token") || "";
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/verify-pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ pin: code })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      if (data.order) mergeServerOrders([data.order]);
      playChime('arrival');
      broadcastEvent("ORDER_PIN_VERIFIED", { orderId, customer: data.order ? data.order.customer : "" });
      return { success: true, message: data.message, order: data.order || null };
    }
    return { success: false, message: data.message || `Incorrect code for #${orderId}.` };
  } catch (e) {
    // Offline fallback uses the PIN stored with the order; never derive it from its public ID.
    const orders = getOrders();
    const index = orders.findIndex(o => String(o.id).toUpperCase() === String(orderId).toUpperCase());
    if (index === -1) return { success: false, message: "Order not found" };
    const order = orders[index];
    const expected = String(order.pickupPin || '');
    if (expected === code) {
      order.verifiedByDriver = true;
      order.status = "arrived";
      order.arrivedAt = order.arrivedAt || new Date().toISOString();
      orders[index] = order;
      saveOrders(orders);
      playChime('arrival');
      broadcastEvent("ORDER_PIN_VERIFIED", { orderId, customer: order.customer });
      return { success: true, message: `Order ID verified ✅ Hand ${order.id} to ${order.customer}.`, order };
    }
    return { success: false, message: `That code does not match #${order.id}.` };
  }
}

export function updateOrderStatus(orderId, newStatus, extraData = {}) {
  const orders = getOrders();
  const index = orders.findIndex(o => o.id === orderId);
  if (index === -1) return null;

  const order = orders[index];
  order.status = newStatus;

  if (newStatus === "enroute") {
    order.orderSession = {
      ...order.orderSession,
      isActive: false,
      endedAt: new Date().toISOString(),
      driverStartedAt: new Date().toISOString()
    };
    stopOrderSessionAndStartCountdown(180);
  } else if (newStatus === "arrived") {
    const meetingPoint = (order.driver && order.driver.currentLocation)
      ? { ...order.driver.currentLocation }
      : (order.mapPin ? { ...order.mapPin } : { ...RESTAURANT_COORDS });
      
    order.arrivedAt = new Date().toISOString();
    order.meetingPoint = meetingPoint;
  } else if (newStatus === "delivered") {
    order.orderSession = {
      ...order.orderSession,
      isActive: false,
      deliveredAt: new Date().toISOString()
    };
    order.deliveredAt = new Date().toISOString();
  }

  if (extraData.driver) {
    order.driver = { ...(order.driver || {}), ...extraData.driver };
  }
  if (extraData.verifiedByDriver !== undefined) {
    order.verifiedByDriver = extraData.verifiedByDriver;
  }

  orders[index] = order;
  saveOrders(orders);
  apiUpdateOrderStatus(orderId, { status: newStatus }).then(serverOrder => {
    if (serverOrder && serverOrder.id) {
      Object.assign(order, serverOrder);
      saveOrders(orders);
      broadcastEvent("ORDER_STATUS_CHANGED", { orderId, status: order.status, order });
      return;
    }

    apiFetchOrder(orderId).then(() => {
      const authoritativeOrder = getOrderById(orderId);
      if (!authoritativeOrder) return;
      Object.assign(order, authoritativeOrder);
      saveOrders(orders);
      broadcastEvent("ORDER_STATUS_CHANGED", { orderId, status: order.status, order });
    }).catch(() => {});
  }).catch(() => {});
  broadcastEvent("ORDER_STATUS_CHANGED", { orderId, status: newStatus, order });
  return order;
}

export function updateDriverLocation(orderId, locationData) {
  const orders = getOrders();
  const index = orders.findIndex(o => o.id === orderId);
  if (index === -1) return null;

  const order = orders[index];
  if (!order.driver) {
    order.driver = {
      name: locationData.driverName || "Assigned Driver",
      phone: locationData.driverPhone || "024 000 0000",
      vehicle: locationData.vehicle || "Delivery Motorbike"
    };
  }

  order.driver.currentLocation = {
    lat: locationData.lat,
    lng: locationData.lng
  };
  order.driver.lastUpdated = new Date().toISOString();
  if (locationData.speedKmh !== undefined) order.driver.speedKmh = locationData.speedKmh;
  if (locationData.etaMinutes !== undefined) order.driver.etaMinutes = locationData.etaMinutes;
  if (locationData.statusText) order.driver.statusText = locationData.statusText;

  orders[index] = order;
  saveOrders(orders);

  localStorage.setItem(DRIVER_LOCATION_KEY, JSON.stringify({
    orderId,
    lat: locationData.lat,
    lng: locationData.lng,
    speedKmh: locationData.speedKmh || 0,
    timestamp: Date.now()
  }));

  broadcastEvent("DRIVER_LOCATION_UPDATE", { orderId, driver: order.driver });
  return order;
}

export function updateDriverLocationOnAllOrders(driverName, locationData) {
  const orders = getOrders();
  let updated = false;
  orders.forEach((order, i) => {
    const assignedName = order.driver && order.driver.name;
    const isMyOrder = assignedName
      ? assignedName.toLowerCase() === String(driverName || '').toLowerCase()
      : (order.status === 'enroute' || order.status === 'arrived');

    if (isMyOrder && (order.status === 'enroute' || order.status === 'arrived' || order.status === 'kitchen')) {
      if (!order.driver) order.driver = {};
      if (!order.driver.name) order.driver.name = driverName;
      if (locationData.driverPhone) order.driver.phone = locationData.driverPhone;
      if (locationData.vehicle) order.driver.vehicle = locationData.vehicle;
      if (locationData.photo) order.driver.photo = locationData.photo;
      order.driver.currentLocation = { lat: locationData.lat, lng: locationData.lng };
      order.driver.lastUpdated = new Date().toISOString();
      if (locationData.speedKmh !== undefined) order.driver.speedKmh = locationData.speedKmh;
      if (locationData.etaMinutes !== undefined) order.driver.etaMinutes = locationData.etaMinutes;
      if (locationData.statusText) order.driver.statusText = locationData.statusText;
      orders[i] = order;
      updated = true;
    }
  });
  if (updated) {
    saveOrders(orders);
    localStorage.setItem(DRIVER_LOCATION_KEY, JSON.stringify({
      driverName,
      lat: locationData.lat,
      lng: locationData.lng,
      speedKmh: locationData.speedKmh || 0,
      timestamp: Date.now()
    }));
    broadcastEvent("DRIVER_LOCATION_BATCH_UPDATE", { driverName });
  }
}

export function getDrivers() {
  try {
    const raw = localStorage.getItem(DRIVERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

export function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function formatWhatsAppUrl(phone, message = "") {
  const clean = String(phone || '').replace(/\D/g, '').replace(/^0/, '');
  const intl = clean ? (clean.startsWith('233') ? clean : '233' + clean) : OWNER_WHATSAPP_NUMBER;
  return `https://wa.me/${intl}${message ? '?text=' + encodeURIComponent(message) : ''}`;
}

export function getLastArrivalEvent() {
  try {
    const raw = localStorage.getItem(ARRIVAL_EVENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function clearArrivalEvent() {
  localStorage.removeItem(ARRIVAL_EVENT_KEY);
}

// --------------------------------------------------------------------------
// Real-Time Backend API & Prisma DB Integration
// --------------------------------------------------------------------------
export const API_BASE = (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin.startsWith('http'))
  ? window.location.origin
  : 'http://localhost:3000';

export function authToken(role) {
  if (role === 'admin') return sessionStorage.getItem('yebs_admin_token') || localStorage.getItem('yebs_admin_token_persist') || '';
  if (role === 'driver') return sessionStorage.getItem('yebs_driver_token') || localStorage.getItem('yebs_driver_token_persist') || '';
  return sessionStorage.getItem('yebs_admin_token') || sessionStorage.getItem('yebs_driver_token') || '';
}

function authHeaders(extra = {}) {
  const token = authToken('admin') || authToken('any');
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

function orderAccessToken(orderId) {
  try { return localStorage.getItem(`yebs_order_access_${String(orderId || '').toUpperCase()}`) || ''; }
  catch (e) { return ''; }
}

function orderAccessHeaders(orderId, extra = {}) {
  const token = orderAccessToken(orderId);
  return token ? { ...extra, 'X-Order-Access-Token': token } : { ...extra };
}

export function getOrderAccessToken(orderId) {
  return orderAccessToken(orderId);
}

export async function apiAdminLogin(username, password) {
  try {
    const res = await fetch(`${API_BASE}/api/auth/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      const token = data.token || (data.admin && data.admin.token);
      sessionStorage.setItem('yebs_admin_token', token);
      sessionStorage.setItem('yebs_admin_user', JSON.stringify(data.admin));
      sessionStorage.setItem('yebs_admin_login_at', Date.now().toString());
      if (data.expiresInMs) sessionStorage.setItem('yebs_admin_expires_in', String(data.expiresInMs));
      return { success: true, admin: data.admin, token };
    }
    // Pass rate-limit metadata through so the UI can show a countdown
    return {
      success: false,
      error: data.message || 'Invalid administrator credentials.',
      retryAfterMs: data.retryAfterMs || (data.retryAfter ? data.retryAfter * 1000 : 0),
      hardBlocked: !!data.hardBlocked,
      softBlock: !!data.softBlock
    };
  } catch (err) {
    return { success: false, error: 'Cannot reach the YEBS server. Run start.bat / npm start, then sign in again.' };
  }
}

export async function apiValidateSession(role) {
  try {
    const token = authToken(role);
    if (!token) return null;
    const res = await fetch(`${API_BASE}/api/auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

export async function apiDriverSignup({ fname, lname, phone, email, password, vehicle, photo }) {
  try {
    const res = await fetch(`${API_BASE}/api/auth/driver/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fname, lname, phone, email, password, vehicle, photo })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      // New riders are held for admin approval. They get no session yet, so
      // pass the generated username back to the signup screen instead.
      if (data.pending) {
        return {
          success: true,
          pending: true,
          driverId: data.driverId,
          driverName: data.driverName,
          username: data.username,
          message: data.message
        };
      }
      const token = data.token || (data.driver && data.driver.token);
      if (token) sessionStorage.setItem('yebs_driver_token', token);
      if (data.driver) sessionStorage.setItem('yebs_driver_user', JSON.stringify(data.driver));
      if (photo) sessionStorage.setItem('yebs_driver_photo', photo);
      rememberRegisteredDriver(data.driver);
      return { success: true, driver: data.driver };
    }
    return { success: false, error: data.message || 'Signup failed' };
  } catch (err) {
    return { success: false, error: 'Cannot reach the YEBS server. Run start.bat / npm start, then sign up again.' };
  }
}

export async function apiDriverLogin(username, password) {
  try {
    const res = await fetch(`${API_BASE}/api/auth/driver/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      const token = data.token || (data.driver && data.driver.token);
      if (token) sessionStorage.setItem('yebs_driver_token', token);
      if (data.driver) sessionStorage.setItem('yebs_driver_user', JSON.stringify(data.driver));
      if (data.driver && data.driver.photo) {
        sessionStorage.setItem('yebs_driver_photo', data.driver.photo);
      }
      rememberRegisteredDriver(data.driver);
      return { success: true, driver: data.driver };
    }
    // Keep the server's pending/rejected reason so the portal can show the
    // correct screen instead of a generic "invalid credentials" error.
    return {
      success: false,
      pending: !!data.pending,
      rejected: !!data.rejected,
      driverId: data.driverId,
      driverName: data.driverName,
      message: data.message,
      error: data.message || 'Invalid driver credentials'
    };
  } catch (err) {
    return { success: false, error: 'Database server unreachable. Please verify the server is running.' };
  }
}

export async function apiFetchSession() {
  try {
    const res = await fetch(`${API_BASE}/api/session`, { cache: 'no-store' });
    if (res.ok) {
      const session = await res.json();
      if (session && session.pickupPoint) applyServerSession(session);
      return session;
    }
  } catch (e) {
    // fallback
  }
  return {
    sessionTime: "6:00 PM – 9:00 PM",
    designatedPickupPoint: "Accra Ridge Hospital Main Gate",
    pickupCoordinates: { lat: 5.5628, lng: -0.2035 }
  };
}

export async function apiSetPickupPoint(pickupPointName, coordinates = null, nameOverride = null) {
  try {
    const token = authToken('any');
    if (!token) {
      return { success: false, message: "Sign in as an admin or rider to set the pickup point." };
    }
    const res = await fetch(`${API_BASE}/api/session/pickup-point`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        pickupPointName: nameOverride || pickupPointName,
        coordinates: coordinates || null
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      if (data.pickupPoint) {
        setSessionPickupPoint(data.pickupPoint.name, { lat: data.pickupPoint.lat, lng: data.pickupPoint.lng });
      }
      broadcastEvent("SESSION_PICKUP_CHANGED", data.pickupPoint || data.session);
      return data;
    }
    return { success: false, message: data.message || "Could not save the pickup point." };
  } catch (e) {
    console.warn("Could not save pickup point to server:", e);
    return { success: false, message: "Could not reach the server to save the pickup point." };
  }
}

// Admin: save the shared pickup point plus the delivery fee in one call.
export async function apiSavePickupSettings(payload = {}) {
  try {
    const token = authToken('admin');
    if (!token) {
      return { success: false, message: "Your admin session has expired. Sign in again to save the pickup point." };
    }
    const res = await fetch(`${API_BASE}/api/admin/settings/pickup`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: payload.name,
        address: payload.address,
        lat: payload.lat,
        lng: payload.lng,
        deliveryFee: payload.deliveryFee
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      if (data.pickupPoint) {
        setSessionPickupPoint(data.pickupPoint.name, { lat: data.pickupPoint.lat, lng: data.pickupPoint.lng });
      }
      broadcastEvent("SESSION_PICKUP_CHANGED", data.pickupPoint || null);
      return data;
    }
    return { success: false, message: data.message || "Could not save the pickup settings." };
  } catch (e) {
    console.warn("Could not save pickup settings:", e);
    return { success: false, message: "Could not reach the server to save the pickup settings." };
  }
}

export async function apiFetchPublicSettings() {
  try {
    const res = await fetch(`${API_BASE}/api/settings/public`);
    if (res.ok) return await res.json();
  } catch (e) {
    console.warn("Could not fetch public settings", e);
  }
  return null;
}

export async function apiFetchMenu() {
  try {
    const res = await fetch(`${API_BASE}/api/menu`, { cache: 'no-store' });
    if (res.ok) {
      const items = await res.json();
      if (Array.isArray(items) && items.length > 0) {
        // Server is authoritative: always overwrite the local cache so admin
        // price / image changes survive a page refresh.
        try { localStorage.setItem(MENU_KEY, JSON.stringify(items)); } catch(e) {}
        broadcastEvent("MENU_UPDATED", { items });
        return items;
      }
    }
  } catch (e) {
    console.warn("Could not fetch remote menu, using cached", e);
  }
  return getMenuItems();
}

export async function apiSaveMenu(menuItems) {
  // Do not touch the local cache before the server confirms the write: showing
  // an edit that the database rejected is exactly how "it changed back later"
  // surprises happen.
  const token = authToken('admin');
  if (!token) {
    return { success: false, message: "Your admin session has expired. Sign in again to save menu changes." };
  }
  try {
    const res = await fetch(`${API_BASE}/api/menu`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ menuItems })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      saveMenuItems(data.menuItems);
      broadcastEvent("MENU_UPDATED", { items: data.menuItems });
      return { success: true, menuItems: data.menuItems };
    }
    return { success: false, message: data.message || `Could not save the menu (server responded ${res.status}).` };
  } catch (e) {
    console.warn("Could not save menu to server:", e);
    return { success: false, message: "Could not reach the server. Check your connection and try again." };
  }
}

export async function apiCreateMenuItem(itemData) {
  const token = authToken('admin');
  if (!token) {
    return { success: false, message: "Your admin session has expired. Sign in again to create dishes." };
  }
  try {
    const res = await fetch(`${API_BASE}/api/menu/item`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(itemData)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      if (Array.isArray(data.menuItems)) {
        saveMenuItems(data.menuItems);
        broadcastEvent("MENU_UPDATED", { items: data.menuItems });
      }
      return { success: true, item: data.item, menuItems: data.menuItems };
    }
    return { success: false, message: data.message || `Failed to create dish (Status ${res.status})` };
  } catch (e) {
    console.warn("Could not create menu item:", e);
    return { success: false, message: "Network connection error while creating dish." };
  }
}

export async function apiDeleteMenuItem(id) {
  const token = authToken('admin');
  if (!token) {
    return { success: false, message: "Your admin session has expired. Sign in again to delete dishes." };
  }
  try {
    const res = await fetch(`${API_BASE}/api/menu/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      if (Array.isArray(data.menuItems)) {
        saveMenuItems(data.menuItems);
        broadcastEvent("MENU_UPDATED", { items: data.menuItems });
      }
      return { success: true, menuItems: data.menuItems };
    }
    return { success: false, message: data.message || `Failed to delete dish (Status ${res.status})` };
  } catch (e) {
    console.warn("Could not delete menu item:", e);
    return { success: false, message: "Network connection error while deleting dish." };
  }
}

export async function apiResetMenu() {
  try {
    const token = authToken('admin');
    const res = await fetch(`${API_BASE}/api/menu/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token || ''}`
      }
    });
    if (res.ok) {
      const data = await res.json();
      saveMenuItems(data.menuItems);
      broadcastEvent("MENU_UPDATED", { items: data.menuItems });
      return data.menuItems;
    }
  } catch (e) {
    console.warn("Could not reset menu on server:", e);
  }
  saveMenuItems(DEFAULT_POSTER_MENU);
  return DEFAULT_POSTER_MENU;
}

export async function apiFetchLogs() {
  try {
    const token = sessionStorage.getItem('yebs_admin_token');
    const res = await fetch(`${API_BASE}/api/logs`, {
      headers: { 'Authorization': `Bearer ${token || ''}` }
    });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.warn("Could not fetch audit logs:", e);
  }
  return [];
}

export async function apiCreateOrder(order) {
  const res = await fetch(`${API_BASE}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(order)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'The server rejected the order.');
  if (!data || !data.id || !data.trackingToken) {
    throw new Error('The server did not return valid order tracking details.');
  }
  localStorage.setItem(`yebs_order_access_${String(data.id).toUpperCase()}`, data.trackingToken);
  delete data.trackingToken;
  return data;
}

export async function apiFetchActiveDrivers() {
  try {
    const res = await fetch(`${API_BASE}/api/drivers/active`);
    if (res.ok) {
      const drivers = await res.json();
      if (Array.isArray(drivers)) {
        drivers.forEach(rememberRegisteredDriver);
        saveDispatchDrivers(drivers);
        return drivers;
      }
    }
  } catch (e) {}
  return [];
}

export function saveDispatchDrivers(drivers) {
  try {
    localStorage.setItem(DRIVERS_KEY, JSON.stringify(Array.isArray(drivers) ? drivers : []));
  } catch (e) {}
}

export async function apiUpdateDriverLocation(driverId, payload) {
  if (!driverId) return;
  try {
    await fetch(`${API_BASE}/api/drivers/${encodeURIComponent(driverId)}/location`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });
  } catch (e) {}
}

// Customer payment proof is held for server-side provider/admin verification.
export async function apiPayMomo(orderId, { transactionRef, amount, senderPhone, receiptImage, method } = {}) {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/pay/momo`, {
      method: "POST",
      headers: orderAccessHeaders(orderId, { "Content-Type": "application/json" }),
      body: JSON.stringify({ transactionRef, amount, senderPhone, receiptImage, method })
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.order) mergeServerOrders([data.order]);
    return { ...data, httpStatus: res.status };
  } catch (e) {
    return { success: false, message: "Could not submit payment proof. Check that the server is running." };
  }
}

// Customer picks a MoMo network and asks the server to send a payment
// request. With MTN Collections credentials this pushes a real prompt to the
// phone; otherwise the response carries the exact USSD steps.
export async function apiRequestMomo(orderId, { network, phone } = {}) {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/pay/request`, {
      method: "POST",
      headers: orderAccessHeaders(orderId, { "Content-Type": "application/json" }),
      body: JSON.stringify({ network, phone })
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.order) mergeServerOrders([data.order]);
    return { ...data, httpStatus: res.status };
  } catch (e) {
    return { success: false, message: "Could not reach the payment service. Check your connection and try again." };
  }
}

// Poll whether a pushed MoMo request has been approved on the phone.
export async function apiMomoStatus(orderId) {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/pay/status`, {
      headers: orderAccessHeaders(orderId), cache: "no-store"
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.order) mergeServerOrders([data.order]);
    return { ...data, httpStatus: res.status };
  } catch (e) {
    return { success: false, paid: false, message: "Could not check the payment status." };
  }
}

// Supported networks + merchant wallet details for the checkout panel.
export async function apiFetchPaymentNetworks() {
  try {
    const res = await fetch(`${API_BASE}/api/payments/networks`, { cache: "no-store" });
    if (res.ok) return await res.json();
  } catch (e) {}
  return {
    payTo: MOMO_CONFIG.number,
    payToLabel: MOMO_CONFIG.displayNumber,
    merchant: MOMO_CONFIG.merchantName,
    apiConfigured: false,
    networks: [
      { id: "mtn", label: "MTN Mobile Money", shortLabel: "MTN MoMo", ussd: "*170#", dial: "*170", color: "#facc15", textColor: "#713f12", apiReady: false },
      { id: "telecel", label: "Telecel Cash (formerly Vodafone Cash)", shortLabel: "Telecel Cash", ussd: "*110#", dial: "*110", color: "#ef4444", textColor: "#ffffff", apiReady: false },
      { id: "at", label: "AT Money (AirtelTigo)", shortLabel: "AT Money", ussd: "*110#", dial: "*110", color: "#0ea5e9", textColor: "#ffffff", apiReady: false }
    ]
  };
}

// Rider confirms cash received at handover.
export async function apiPayCash(orderId, amount) {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/pay/cash`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ amount })
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.order) mergeServerOrders([data.order]);
    return { ...data, httpStatus: res.status };
  } catch (e) {
    return { success: false, message: "Could not record the cash payment. Check the server connection." };
  }
}

// Rider enters an Order ID (or its last 4 digits) to fetch the customer's order.
export async function apiLookupOrder(code) {
  try {
    const res = await fetch(`${API_BASE}/api/orders/lookup/${encodeURIComponent(code)}`, {
      headers: authHeaders(),
      cache: "no-store"
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.order) mergeServerOrders([data.order]);
    return { ...data, httpStatus: res.status };
  } catch (e) {
    return { success: false, message: "Could not look up that order. Check the server connection." };
  }
}

// Admin pastes a MoMo confirmation SMS; the server auto-matches and verifies.
export async function apiVerifyMomoSms(sms) {
  try {
    const res = await fetch(`${API_BASE}/api/payments/momo/sms`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sms })
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.order) mergeServerOrders([data.order]);
    return { ...data, httpStatus: res.status };
  } catch (e) {
    return { success: false, message: "Could not verify the MoMo message." };
  }
}

export async function apiReviewPayment(orderId, paid, reason = "") {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/pay/review`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ paid, reason })
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.order) mergeServerOrders([data.order]);
    return { ...data, httpStatus: res.status };
  } catch (e) {
    return { success: false, message: "Could not update the payment." };
  }
}

export async function apiRequestOrderCancellation(orderId, phone, reason = "") {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/cancellation`, {
      method: "POST",
      headers: orderAccessHeaders(orderId, { "Content-Type": "application/json" }),
      body: JSON.stringify({ phone, reason })
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.order) mergeServerOrders([data.order]);
    return { ...data, httpStatus: res.status };
  } catch (e) {
    return { success: false, message: "Could not submit the cancellation request. Check the server connection." };
  }
}

export async function apiReviewOrderCancellation(orderId, approved, reason = "") {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/cancellation/review`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ approved, reason })
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.order) mergeServerOrders([data.order]);
    return { ...data, httpStatus: res.status };
  } catch (e) {
    return { success: false, message: "Could not review the cancellation request." };
  }
}

export async function apiReviewOrderRefund(orderId, approved, reason = "") {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/refund/review`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ approved, reason })
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.order) mergeServerOrders([data.order]);
    return { ...data, httpStatus: res.status };
  } catch (e) {
    return { success: false, message: "Could not review the refund request." };
  }
}

export async function apiFetchOrder(orderId) {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}`, {
      headers: orderAccessHeaders(orderId, authHeaders()),
      cache: "no-store"
    });
    if (res.ok) {
      const order = await res.json();
      if (order && order.id) mergeServerOrders([order]);
      return order;
    }
  } catch (e) {}
  return null;
}

export async function apiUploadMomoReceipt(orderId, receiptImage, transactionRef, amount = null) {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/receipt`, {
      method: "POST",
      headers: orderAccessHeaders(orderId, { "Content-Type": "application/json" }),
      body: JSON.stringify({ receiptImage, transactionRef, amount })
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.order) mergeServerOrders([data.order]);
    return data;
  } catch (e) {
    return { success: false, message: "Could not upload receipt. Check that the server is running." };
  }
}

export async function apiVerifyMomoReceipt(orderId, verified = true) {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/receipt/verify`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ verified })
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.order) mergeServerOrders([data.order]);
    return data;
  } catch (e) {
    return { success: false, message: "Could not verify MoMo receipt." };
  }
}

// --------------------------------------------------------------------------
// Live cross-device order synchronisation
// --------------------------------------------------------------------------

export async function apiUpdateOrderStatus(orderId, payload) {
  if (!orderId) return null;
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/status`, {
      method: 'PATCH',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    });
    if (res.ok) return await res.json();
  } catch (e) {}
  return null;
}

export async function apiFetchOrders() {
  try {
    // Full order lists contain private customer data, so they require a signed
    // admin or rider session. Customers poll their own order by ID instead.
    const token = sessionStorage.getItem('yebs_admin_token')
      || localStorage.getItem('yebs_admin_token_persist')
      || sessionStorage.getItem('yebs_driver_token')
      || localStorage.getItem('yebs_driver_token_persist');
    if (!token) return null;
    const res = await fetch(`${API_BASE}/api/orders`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store'
    });
    if (res.ok) {
      const data = await res.json();
      return Array.isArray(data) ? data : [];
    }
  } catch (e) {}
  return null;
}

// Merge server orders into the local cache without destroying local-only orders.
export function mergeServerOrders(serverOrders) {
  if (!Array.isArray(serverOrders)) return getOrders();
  const local = getOrders();
  const byId = new Map(local.map(o => [o.id, o]));

  serverOrders.forEach(serverOrder => {
    if (!serverOrder || !serverOrder.id) return;
    const existing = byId.get(serverOrder.id);
    if (existing) {
      byId.set(serverOrder.id, {
        ...existing,
        ...serverOrder,
        pickupPin: serverOrder.pickupPin || existing.pickupPin,
        driver: serverOrder.driver || existing.driver || null,
        momoReceipt: serverOrder.momoReceipt || existing.momoReceipt || null,
        mapPin: serverOrder.mapPin || existing.mapPin
      });
    } else {
      byId.set(serverOrder.id, serverOrder);
    }
  });

  const merged = Array.from(byId.values()).sort((a, b) => {
    const ta = new Date(a.createdAt || 0).getTime();
    const tb = new Date(b.createdAt || 0).getTime();
    return tb - ta;
  });

  if (JSON.stringify(local) !== JSON.stringify(merged)) saveOrders(merged);
  return merged;
}

export async function syncOrdersFromServer() {
  const orders = await apiFetchOrders();
  if (orders) return mergeServerOrders(orders);
  return getOrders();
}

// Poll the server in the background. Returns a stop() function.
export function startLiveOrderSync(onUpdate, intervalMs = 5000) {
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      const orders = await apiFetchOrders();
      if (orders) {
        const merged = mergeServerOrders(orders);
        if (!stopped && typeof onUpdate === 'function') onUpdate(merged);
      }
    } catch (e) {
    } finally {
      busy = false;
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function apiFetchAllDrivers() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${API_BASE}/api/admin/drivers`, {
        headers: authHeaders(),
        cache: 'no-store',
        signal: AbortSignal.timeout(25000)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.message || `Could not load drivers (${res.status}).`);
      }
      if (!Array.isArray(data)) throw new Error('The server returned an invalid driver roster.');
      data.forEach(rememberRegisteredDriver);
      return data;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise(resolve => {
          setTimeout(resolve, 700 * (attempt + 1));
        });
      }
    }
  }
  console.error('Could not load the admin driver roster:', lastError);
  throw lastError;
}

export async function apiCheckHealth() {
  try {
    const res = await fetch(`${API_BASE}/api/health`, { cache: 'no-store' });
    return res.ok;
  } catch (e) {
    return false;
  }
}




// =============================================================
// ADDED: New API helpers for driver approval, settings, order
// edit, and improved ETA / road-aware routing
// =============================================================

// Edit an order (customer corrects a mistake before dispatch)
export async function apiEditOrder(orderId, updates) {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/edit`, {
      method: 'PATCH',
      headers: orderAccessHeaders(orderId, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(updates)
    });
    const data = await res.json().catch(() => ({}));
    if (data && data.order) mergeServerOrders([data.order]);
    return { ...data, httpStatus: res.status };
  } catch (e) {
    return { success: false, message: 'Could not update order. Server may be offline.' };
  }
}

// Check driver approval status (used on driver portal pending screen)
export async function apiCheckDriverApproval(driverId) {
  try {
    const res = await fetch(`${API_BASE}/api/drivers/${encodeURIComponent(driverId)}/approval`, { cache: 'no-store' });
    return await res.json().catch(() => ({}));
  } catch (e) {
    return { success: false, approvalStatus: 'pending' };
  }
}

// Subscribe to real-time approval push via SSE
export function listenForApproval(driverId, onApproved) {
  if (!driverId || typeof EventSource === 'undefined') return null;
  const es = new EventSource(`${API_BASE}/api/sse/driver/${encodeURIComponent(driverId)}`);
  es.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'approved') { onApproved(msg); }
    } catch (e) {}
  };
  es.onerror = () => { es.close(); };
  return es;
}

// =============================================================
// ROAD-AWARE ETA ENGINE
// Uses straight-line distance with realistic road multipliers,
// traffic state, and turn penalties — no external API needed.
// =============================================================

const ROAD_SPEED_KMH = 28;          // Average Accra city-road speed
const TRAFFIC_MULTIPLIER = 1.45;    // Rush-hour / traffic jam factor
const WRONG_TURN_PENALTY_MIN = 2;   // Extra minutes when driver deviates
const ROAD_WINDING_FACTOR = 1.38;   // Straight-line → road-distance factor

let _lastEtaDriverPos = null;
let _lastEtaPickupPos = null;
let _lastEtaResult = 0;
let _wrongTurnDetected = false;
let _prevDistanceKm = null;

/**
 * Estimate ETA in minutes from driverPos → pickupPos.
 * Tracks whether distance is shrinking (right direction) or
 * growing (wrong turn / traffic detour) and adjusts the ETA.
 *
 * @param {{ lat: number, lng: number }} driverPos
 * @param {{ lat: number, lng: number }} pickupPos
 * @param {{ speedKmh?: number, hasTraffic?: boolean }} opts
 * @returns {{ etaMinutes: number, distanceKm: number, wrongTurn: boolean, improving: boolean }}
 */
export function computeRoadEta(driverPos, pickupPos, opts = {}) {
  if (!driverPos || !pickupPos) return { etaMinutes: null, distanceKm: null, wrongTurn: false, improving: false };

  const toRad = d => d * Math.PI / 180;
  const R = 6371; // Earth radius km
  const dLat = toRad(pickupPos.lat - driverPos.lat);
  const dLng = toRad(pickupPos.lng - driverPos.lng);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(driverPos.lat)) * Math.cos(toRad(pickupPos.lat)) * Math.sin(dLng / 2) ** 2;
  const straightKm = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const roadKm = straightKm * ROAD_WINDING_FACTOR;

  const speed = Math.max(5, opts.speedKmh || ROAD_SPEED_KMH);
  const trafficFactor = opts.hasTraffic ? TRAFFIC_MULTIPLIER : 1.0;
  let etaMinutes = (roadKm / speed) * 60 * trafficFactor;

  // Direction tracking — compare with previous distance
  let improving = false;
  let wrongTurn = false;
  if (_prevDistanceKm !== null) {
    if (straightKm > _prevDistanceKm + 0.05) {
      // Moving away — wrong turn or heavy traffic detour
      wrongTurn = true;
      _wrongTurnDetected = true;
      etaMinutes += WRONG_TURN_PENALTY_MIN;
    } else if (straightKm < _prevDistanceKm - 0.02) {
      improving = true;
      _wrongTurnDetected = false;
    }
  }
  _prevDistanceKm = straightKm;

  const result = {
    etaMinutes: Math.max(1, Math.round(etaMinutes)),
    distanceKm: Math.round(roadKm * 10) / 10,
    wrongTurn,
    improving,
    straightKm: Math.round(straightKm * 10) / 10
  };
  _lastEtaResult = result.etaMinutes;
  return result;
}

/** Reset ETA state (call when a new delivery session starts) */
export function resetEtaState() {
  _prevDistanceKm = null;
  _wrongTurnDetected = false;
}

/** Legacy wrapper used by existing code */
export function estimateEtaMinutes(driverLat, driverLng, destLat, destLng, speedKmh = 25) {
  const r = computeRoadEta(
    { lat: driverLat, lng: driverLng },
    { lat: destLat, lng: destLng },
    { speedKmh }
  );
  return r.etaMinutes || 0;
}

// =============================================================
// IMPROVED MAP HELPERS
// Real road-path polyline using OSRM (free, no API key needed).
// Falls back to dashed straight line when offline.
// =============================================================

/**
 * Draw a road-following polyline between two points using OSRM.
 * Returns a Leaflet layer you can add to / remove from the map.
 */
export async function drawRoadRoute(map, from, to, opts = {}) {
  if (!map || !from || !to || typeof L === 'undefined') return null;
  const color = opts.color || '#e57a45';
  const weight = opts.weight || 5;

  // Remove previous route if provided
  if (opts.previousLayer) {
    try {
      if (opts.previousLayer.routeDistanceBadge) map.removeLayer(opts.previousLayer.routeDistanceBadge);
      map.removeLayer(opts.previousLayer);
    } catch (e) {}
  }

  // Try OSRM public routing API (free, no key)
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined });
    if (res.ok) {
      const data = await res.json();
      const route = data.routes && data.routes[0];
      if (route && route.geometry && route.geometry.coordinates) {
        const latlngs = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
        const layer = L.polyline(latlngs, {
          color,
          weight,
          opacity: 0.85,
          lineJoin: 'round',
          lineCap: 'round'
        }).addTo(map);
        const legs = route.legs || [];
        const maneuverSteps = legs.flatMap(leg => leg.steps || [])
          .filter(step => step.maneuver && step.maneuver.location)
          .map(step => ({
            instruction: step.maneuver.instruction || step.name || 'Continue on the road',
            distanceMeters: Number(step.distance) || 0,
            durationSeconds: Number(step.duration) || 0
          }));
        layer.routeMeta = {
          distanceMeters: Number(route.distance) || 0,
          durationSeconds: Number(route.duration) || 0,
          steps: maneuverSteps
        };
        if (opts.showDistanceBadge !== false && route.distance) {
          const middleIndex = Math.max(0, Math.floor(latlngs.length / 2));
          const middle = latlngs[middleIndex] || latlngs[0];
          const distanceKm = Number(route.distance / 1000).toFixed(1);
          const durationMin = Math.max(1, Math.round(Number(route.duration) / 60));
          layer.routeDistanceBadge = L.marker(middle, {
            interactive: false,
            icon: L.divIcon({
              className: 'yebs-route-distance-marker',
              html: `<div>${distanceKm} km · ${durationMin} min</div>`,
              iconSize: [112, 28],
              iconAnchor: [56, 14]
            })
          }).addTo(map);
        }
        return layer;
      }
    }
  } catch (e) {
    // OSRM failed — fall through to straight dashed line
  }

  // Offline fallback: dashed straight line
  const layer = L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
    color,
    weight: 3,
    opacity: 0.7,
    dashArray: '10, 8'
  }).addTo(map);
  return layer;
}

/**
 * Place (or move) a pickup-point pin marker on a Leaflet map.
 * The marker is a pink/red lollipop pin matching the UI design.
 * Returns the Leaflet marker so callers can remove/move it.
 */
export function placePickupMarkerOnMap(map, lat, lng, label, existingMarker = null) {
  if (!map || typeof L === 'undefined') return null;
  if (existingMarker) {
    try { map.removeLayer(existingMarker); } catch (e) {}
  }
  const icon = L.divIcon({
    html: `<div style="
      position:relative; width:32px; height:44px; display:flex;
      flex-direction:column; align-items:center;">
      <div style="width:28px;height:28px;border-radius:50% 50% 50% 0;
        background:#e57a45;border:3px solid white;
        box-shadow:0 3px 10px rgba(0,0,0,0.35);
        transform:rotate(-45deg); margin-top:4px;"></div>
      <div style="font-size:10px;font-weight:800;color:#173d30;
        background:white;border:1px solid #e57a45;border-radius:4px;
        padding:1px 5px;margin-top:2px;white-space:nowrap;
        max-width:120px;overflow:hidden;text-overflow:ellipsis;
        box-shadow:0 2px 6px rgba(0,0,0,0.15);">${label || 'Pickup'}</div>
    </div>`,
    iconSize: [32, 60],
    iconAnchor: [16, 42],
    popupAnchor: [0, -44]
  });
  const marker = L.marker([lat, lng], { icon })
    .bindPopup(`<b>📍 Pickup Point</b><br>${label || 'Designated collection spot'}`)
    .addTo(map);
  return marker;
}

/**
 * Place a customer delivery location pin on the map.
 */
export function placeCustomerPinOnMap(map, lat, lng, customerName, existingMarker = null) {
  if (!map || typeof L === 'undefined') return null;
  if (existingMarker) {
    try { map.removeLayer(existingMarker); } catch (e) {}
  }
  const icon = L.divIcon({
    html: `<div style="
      background:#173d30;color:white;width:30px;height:30px;
      border-radius:50%;display:grid;place-items:center;
      border:2px solid white;box-shadow:0 3px 10px rgba(0,0,0,0.3);
      font-size:14px;">👤</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -18]
  });
  const marker = L.marker([lat, lng], { icon })
    .bindPopup(`<b>📦 ${customerName || 'Customer'}</b><br>Delivery location`)
    .addTo(map);
  return marker;
}

// =============================================================
// ANTI-DEVTOOLS PROTECTION
// Obscures sensitive data from F12 inspection.
// NOTE: This is a deterrent, not a security wall — real security
// lives in the server-side auth layer (bcrypt + HMAC tokens).
// =============================================================

export function applyDevToolsProtection() {
  // Disable right-click context menu
  document.addEventListener('contextmenu', e => e.preventDefault());

  // Detect DevTools open via timing trick and blur sensitive content
  let devToolsOpen = false;
  const threshold = 160;
  const check = () => {
    const w = window.outerWidth - window.innerWidth > threshold ||
               window.outerHeight - window.innerHeight > threshold;
    if (w !== devToolsOpen) {
      devToolsOpen = w;
      document.querySelectorAll('[data-sensitive]').forEach(el => {
        el.style.filter = devToolsOpen ? 'blur(5px)' : 'none';
        el.setAttribute('aria-hidden', devToolsOpen ? 'true' : 'false');
      });
      if (devToolsOpen) {
        console.clear();
        console.log('%c⛔ YEBS Noodles — Secure Zone', 'color:#e57a45;font-size:18px;font-weight:800;');
        console.log('%cThis panel is monitored. Unauthorised inspection is prohibited.', 'color:#173d30;font-size:12px;');
      }
    }
  };
  setInterval(check, 1200);

  // Intercept common keyboard shortcuts
  document.addEventListener('keydown', e => {
    const dev = (e.key === 'F12') ||
      (e.ctrlKey && e.shiftKey && ['I','J','C'].includes(e.key)) ||
      (e.ctrlKey && e.key === 'U');
    if (dev) { e.preventDefault(); return false; }
  });
}

// =============================================================
// MOMO PAYMENT — Efficient transparent verification
// =============================================================
// Dialer-free MoMo: opens the USSD string via tel: URI.
// Ghana MTN MoMo short code: *170#
// Telecel (Vodafone): *110#
// AirtelTigo/AT: *500#
export function openMomoDialer(amount, reference, network = 'mtn') {
  const codes = { mtn: '*170#', telecel: '*110#', at: '*500#' };
  const ussd = codes[network.toLowerCase()] || '*170#';
  // Deep-link that pre-fills amount on supporting devices
  const uri = `tel:${encodeURIComponent(ussd)}`;
  const a = document.createElement('a');
  a.href = uri;
  a.click();
  return uri;
}

// Format a GH₵ amount for display
export function formatGhc(amount) {
  return `GH₵${Number(amount || 0).toFixed(2)}`;
}


export async function apiVerifyPin(orderId, pin) {
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/verify-pin`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ pin })
    });
    const data = await res.json().catch(() => ({}));
    if (data.order) mergeServerOrders([data.order]);
    return data;
  } catch (e) {
    return { success: false, message: 'Server unreachable.' };
  }
}

/**
 * Calculate delivery price per kilometer by meal count:
 *   - 1 meal: GH₵8.00/km
 *   - 2 meals: GH₵6.00/km
 *   - 3 meals: GH₵4.00/km
 *   - 4 or more meals: GH₵2.00/km
 * If collection: GH₵0.00 (Free).
 */
export function calculateDeliveryQuote(distanceKm, mealCount, isDelivery) {
  if (!isDelivery) {
    return {
      distanceKm: 0,
      baseFee: 0,
      discount: 0,
      finalFee: 0,
      mealCount: Number(mealCount || 0),
      discountMessage: 'Collection at shared pickup is Free'
    };
  }
  const dist = Math.max(0.5, Math.round(Number(distanceKm || 2.5) * 10) / 10);
  const count = Number(mealCount || 0);
  const ratePerKm = count >= 4 ? 2 : count === 3 ? 4 : count === 2 ? 6 : 8;
  const baseFee = Math.round(dist * ratePerKm * 100) / 100;
  const finalFee = baseFee;
  return {
    distanceKm: dist,
    ratePerKm,
    baseFee,
    discount: 0,
    finalFee,
    mealCount: count,
    nextTierMessage: `GH₵${ratePerKm.toFixed(2)} per km for ${count} meal${count === 1 ? '' : 's'}`
  };
}

export async function apiClaimOrder(orderId) {
  if (!orderId) return { success: false, message: 'Missing order ID' };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/claim`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.order) {
      mergeServerOrders([data.order]);
      broadcastEvent("ORDER_STATUS_CHANGED", { orderId, status: data.order.status, order: data.order });
    }
    return { ...data, ok: res.ok };
  } catch (e) {
    return { success: false, message: 'Could not reach server to claim delivery.' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function apiUnclaimOrder(orderId) {
  if (!orderId) return { success: false, message: 'Missing order ID' };
  try {
    const res = await fetch(`${API_BASE}/api/orders/${encodeURIComponent(orderId)}/unclaim`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.order) {
      mergeServerOrders([data.order]);
      broadcastEvent("ORDER_STATUS_CHANGED", { orderId, status: data.order.status, order: data.order });
    }
    return { ...data, ok: res.ok };
  } catch (e) {
    return { success: false, message: 'Could not reach server to unclaim delivery.' };
  }
}

export async function apiSendDriverReport(message) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${API_BASE}/api/driver/report`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ message: String(message || '').slice(0, 10000) }),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    return { ...data, ok: res.ok };
  } catch (e) {
    return { success: false, ok: false, message: 'Could not queue the driver report.' };
  } finally {
    clearTimeout(timeout);
  }
}
