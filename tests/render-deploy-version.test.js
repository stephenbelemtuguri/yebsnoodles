const { resolveAdminCredentialResetVersion } = require('../scripts/render-deploy-version');

describe('administrator reset version', () => {
  test('does not derive a reset from Render deploys or commit IDs', () => {
    expect(resolveAdminCredentialResetVersion({
      RENDER: 'true',
      RENDER_GIT_COMMIT: 'commit-id',
      RENDER_SERVICE_ID: 'service-id'
    })).toBe('');
  });

  test('uses an explicitly configured reset version on Render', () => {
    expect(resolveAdminCredentialResetVersion({
      RENDER: 'true',
      RENDER_GIT_COMMIT: 'commit-id',
      ADMIN_CREDENTIAL_RESET_VERSION: 'manual-version'
    })).toBe('manual-version');
  });

  test('trims whitespace from the explicit reset version', () => {
    expect(resolveAdminCredentialResetVersion({
      ADMIN_CREDENTIAL_RESET_VERSION: '  manual-version  '
    })).toBe('manual-version');
  });
});
