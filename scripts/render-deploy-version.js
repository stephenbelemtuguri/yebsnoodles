function createDeploymentVersion() {
  const crypto = require('crypto');
  return `build-${Date.now()}-${crypto.randomUUID()}`;
}

function resolveAdminCredentialResetVersion(env = process.env, buildVersion = '') {
  if (env.RENDER || env.RENDER_SERVICE_ID) {
    const deployment = String(buildVersion || env.RENDER_GIT_COMMIT || '').trim();
    if (deployment) {
      return `render-deploy-${deployment}`;
    }
  }

  return String(env.ADMIN_CREDENTIAL_RESET_VERSION || '').trim();
}

module.exports = { createDeploymentVersion, resolveAdminCredentialResetVersion };
