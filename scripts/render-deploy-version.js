function resolveAdminCredentialResetVersion(env = process.env) {
  return String(env.ADMIN_CREDENTIAL_RESET_VERSION || '').trim();
}

module.exports = { resolveAdminCredentialResetVersion };
