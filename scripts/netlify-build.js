// Build the static site for Netlify.
// Only browser-facing assets are copied to dist/ — server code, the local
// database.json, secrets and the unrelated CAD folder stay out of the deploy.

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

const FILES = [
  'index.html',
  'admin.html',
  'driver.html',
  'shared.js',
  'recovery.js',
  'sw.js',
  'manifest.json'
];

const DIRS = ['public', 'vendor'];

const ROOT_ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.gif', '.css', '.woff', '.woff2']);

const SKIP_DIRS = new Set(['stephen 1', 'node_modules', '.git']);
const SKIP_FILES = new Set(['index (1).html']);

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      count += copyDir(path.join(from, entry.name), path.join(to, entry.name));
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      copyFile(path.join(from, entry.name), path.join(to, entry.name));
      count += 1;
    }
  }
  return count;
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

let copied = 0;

for (const file of FILES) {
  const src = path.join(root, file);
  if (fs.existsSync(src)) {
    copyFile(src, path.join(dist, file));
    copied += 1;
  }
}

for (const dir of DIRS) {
  copied += copyDir(path.join(root, dir), path.join(dist, dir));
}

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (SKIP_FILES.has(entry.name)) continue;
  if (!ROOT_ASSET_EXT.has(path.extname(entry.name).toLowerCase())) continue;
  copyFile(path.join(root, entry.name), path.join(dist, entry.name));
  copied += 1;
}

console.log(`[netlify] published ${copied} static files to dist/`);

// Guard against broken food cards: every local menu photo must exist in dist/.
try {
  const db = JSON.parse(fs.readFileSync(path.join(root, 'database.json'), 'utf8'));
  const missing = [];
  for (const item of db.menuItems || []) {
    const raw = String(item.image || '').trim();
    if (!raw || /^(data:|blob:|https?:)/i.test(raw)) continue;
    const rel = raw.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^(public\/)+/i, '').replace(/^stephen 1\//i, '');
    if (!rel) continue;
    if (!fs.existsSync(path.join(dist, rel))) missing.push(`${item.name || item.id}: ${rel}`);
  }
  if (missing.length) {
    console.error('[netlify] missing menu images:\n  ' + missing.join('\n  '));
    process.exitCode = 1;
  } else {
    console.log('[netlify] all menu photos are present in dist/');
  }
} catch (err) {
  console.warn('[netlify] could not verify menu photos:', err.message);
}
