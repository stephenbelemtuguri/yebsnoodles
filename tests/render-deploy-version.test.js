const fs = require('node:fs');
const path = require('node:path');
const { resolveAdminCredentialResetVersion } = require('../scripts/render-deploy-version');

describe('Render environment blueprint', () => {
  test('keeps the Supabase role key private and generates a stable session secret', () => {
    const blueprint = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');

    expect(blueprint).toMatch(/- key: SUPABASE_SERVICE_ROLE_KEY\r?\n\s+sync: false/);
    expect(blueprint).toMatch(/- key: YEBS_AUTH_SECRET\r?\n\s+generateValue: true/);
    expect(blueprint).not.toMatch(/key: YEBS_AUTH_SECRET\r?\n\s+value:/);
  });
});

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
