function resolveAdminCredentialResetVersion(env = process.env) {
  const commit = String(env.RENDER_GIT_COMMIT || '').trim();
  if (commit) {
    return `render-deploy-${commit}`;
  }

  return String(env.ADMIN_CREDENTIAL_RESET_VERSION || '').trim();
}

module.exports = { resolveAdminCredentialResetVersion };
