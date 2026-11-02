// Additions to app.json that depend on local files or variables.
// - Firebase's `google-services.json` (FCM push wakes, Phase 12) is git-ignored: with it the
//   build receives pushes; without it the app still builds and simply fetches messages when
//   opened. `GOOGLE_SERVICES_JSON` may point elsewhere.
// - iOS Google Sign-In (Phase 28): with `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` set, the plugin
//   registers its reversed form as a URL scheme. Without options the plugin would assume
//   Firebase (Phase 7 note), so it is added only with the scheme.
const { existsSync } = require('node:fs');
const path = require('node:path');

/** `<id>.apps.googleusercontent.com` → `com.googleusercontent.apps.<id>`. */
function reversedClientId(clientId) {
  const match = /^(.+)\.apps\.googleusercontent\.com$/.exec(clientId ?? '');
  return match ? `com.googleusercontent.apps.${match[1]}` : undefined;
}

module.exports = ({ config }) => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON ?? './google-services.json';
  const present = existsSync(path.resolve(__dirname, googleServicesFile));
  const iosUrlScheme = reversedClientId(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID);
  return {
    ...config,
    android: { ...config.android, ...(present ? { googleServicesFile } : {}) },
    plugins: [
      ...(config.plugins ?? []),
      ...(iosUrlScheme ? [['@react-native-google-signin/google-signin', { iosUrlScheme }]] : []),
      // Release builds signed with the upload key from ~/.gradle/gradle.properties (Phase 20).
      './plugins/with-release-signing',
    ],
  };
};

module.exports.reversedClientId = reversedClientId;
