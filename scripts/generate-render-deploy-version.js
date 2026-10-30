const fs = require('fs');
const path = require('path');
const { createDeploymentVersion } = require('./render-deploy-version');

const outputPath = path.join(__dirname, '..', '.render-deploy-version');
const version = createDeploymentVersion();

fs.writeFileSync(outputPath, `${version}\n`, { encoding: 'utf8', mode: 0o600 });
console.log('[deploy] Generated a unique Render build marker.');
