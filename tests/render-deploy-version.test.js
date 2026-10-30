const { resolveAdminCredentialResetVersion } = require('../scripts/render-deploy-version');

describe('Render administrator reset version', () => {
  test('uses the Git commit as a stable version for one deployment', () => {
    const env = { RENDER_GIT_COMMIT: 'abc123' };
    const first = resolveAdminCredentialResetVersion(env);
    const second = resolveAdminCredentialResetVersion(env);

    expect(first).toBe('render-deploy-abc123');
    expect(second).toBe(first);
  });

  test('produces a new version for a different deployed commit', () => {
    const first = resolveAdminCredentialResetVersion({
      RENDER_GIT_COMMIT: 'first-commit'
    });
    const second = resolveAdminCredentialResetVersion({
      RENDER_GIT_COMMIT: 'second-commit'
    });

    expect(second).not.toBe(first);
  });

  test('uses the manually configured version when not running on Render', () => {
    expect(resolveAdminCredentialResetVersion({
      ADMIN_CREDENTIAL_RESET_VERSION: 'manual-version'
    })).toBe('manual-version');
  });
});
