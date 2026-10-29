const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('Testing server.js syntax...');
execSync('node -c server.js', { stdio: 'inherit' });

console.log('Testing ES modules syntax...');
for (const m of ['shared.js', 'recovery.js']) {
  const tmp = `_${m}.mjs`;
  fs.copyFileSync(m, tmp);
  try {
    execSync(`node --check ${tmp}`, { stdio: 'inherit' });
  } finally {
    fs.unlinkSync(tmp);
  }
}

console.log('Testing HTML inline scripts...');
const htmlFiles = [
  'index.html',
  'admin.html',
  'driver.html',
  'public/customer-portal.html',
  'public/receipts.html',
  'public/customer-reviews.html'
];

for (const f of htmlFiles) {
  if (!fs.existsSync(f)) continue;
  const content = fs.readFileSync(f, 'utf8');
  const regex = /<script(?:\s+type="module")?[^>]*>([\s\S]*?)<\/script>/gi;
  let match, idx = 0;
  while ((match = regex.exec(content)) !== null) {
    idx++;
    const code = match[1].trim();
    if (!code) continue;
    const tmp = `_temp_chk_${idx}.mjs`;
    fs.writeFileSync(tmp, code);
    try {
      execSync(`node --check ${tmp}`, { stdio: 'pipe' });
    } catch (e) {
      console.error(`Syntax error in ${f} script #${idx}:`, e.stderr ? e.stderr.toString() : e.message);
      process.exit(1);
    } finally {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    }
  }
}

console.log('All syntax checks PASSED successfully!');
