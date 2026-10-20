// Additions to app.json that depend on local files. Firebase's `google-services.json` (FCM push
// wakes, Phase 12) is git-ignored: with it the build receives pushes; without it the app still
// builds and simply fetches messages when opened. `GOOGLE_SERVICES_JSON` may point elsewhere.
const { existsSync } = require('node:fs');
const path = require('node:path');

module.exports = ({ config }) => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON ?? './google-services.json';
  const present = existsSync(path.resolve(__dirname, googleServicesFile));
  return {
    ...config,
    android: { ...config.android, ...(present ? { googleServicesFile } : {}) },
  };
};
