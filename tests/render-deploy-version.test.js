const {
  createDeploymentVersion,
  resolveAdminCredentialResetVersion
} = require('../scripts/render-deploy-version');

describe('Render administrator reset version', () => {
  test('generates a unique marker for each new build', () => {
    const first = createDeploymentVersion();
    const second = createDeploymentVersion();

    expect(first).toMatch(/^build-\d+-[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });

  test('uses the generated build marker on Render', () => {
    const version = resolveAdminCredentialResetVersion(
      { RENDER: 'true', RENDER_GIT_COMMIT: 'commit-id' },
      'build-marker'
    );

    expect(version).toBe('render-deploy-build-marker');
  });

  test('falls back to the Render commit if a build marker is unavailable', () => {
    expect(resolveAdminCredentialResetVersion({
      RENDER: 'true',
      RENDER_GIT_COMMIT: 'commit-id'
    })).toBe('render-deploy-commit-id');
  });

  test('uses the manually configured version outside Render', () => {
    expect(resolveAdminCredentialResetVersion({
      RENDER: '',
      ADMIN_CREDENTIAL_RESET_VERSION: 'manual-version'
    })).toBe('manual-version');
  });
});
