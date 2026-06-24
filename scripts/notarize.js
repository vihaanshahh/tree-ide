// electron-builder afterSign hook: notarize the macOS .app with Apple.
//
// This is intentionally a no-op unless the Apple credentials are present in
// the environment, so local/unsigned builds (and CI runs before the Apple
// Developer ID is configured) continue to work untouched. Once these three
// env vars are set in CI, every signed mac build is notarized + stapled:
//
//   APPLE_ID                     your Apple Developer account email
//   APPLE_APP_SPECIFIC_PASSWORD  app-specific password (appleid.apple.com)
//   APPLE_TEAM_ID                10-char Team ID from developer.apple.com
//
'use strict';

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[notarize] Apple credentials not set — skipping notarization.');
    return;
  }

  // Lazy-require so the dependency is optional for unsigned builds.
  let notarize;
  try {
    ({ notarize } = require('@electron/notarize'));
  } catch (e) {
    console.warn('[notarize] @electron/notarize not installed — skipping.', e.message);
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`[notarize] submitting ${appName}.app to Apple — this can take a few minutes…`);
  await notarize({ appPath, appleId, appleIdPassword, teamId });
  console.log('[notarize] done.');
};
