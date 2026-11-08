// Additions to app.json that depend on local files or variables.
// - Firebase's `google-services.json` (FCM push wakes, Phase 12) is git-ignored: with it the
//   build receives pushes; without it the app still builds and simply fetches messages when
//   opened. `GOOGLE_SERVICES_JSON` may point elsewhere.
// - iOS Google Sign-In (Phase 28): with `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` set, the plugin
//   registers its reversed form as a URL scheme. Without options the plugin would assume
//   Firebase (Phase 7 note), so it is added only with the scheme.
// - iOS push (Phase 29, ADR 0032): `PINGDOST_APS_ENVIRONMENT=production` for TestFlight and App
//   Store builds, else `development` (sandbox APNs). It sets the `aps-environment` entitlement
//   (expo-notifications `mode`) and `extra.apsEnvironment`, which the app sends with its tokens
//   so the server picks Apple's matching gateway. Background remote notifications are on so a
//   suspended app can fetch after a wake.
const { existsSync } = require('node:fs');
const path = require('node:path');

/** `<id>.apps.googleusercontent.com` → `com.googleusercontent.apps.<id>`. */
function reversedClientId(clientId) {
  const match = /^(.+)\.apps\.googleusercontent\.com$/.exec(clientId ?? '');
  return match ? `com.googleusercontent.apps.${match[1]}` : undefined;
}

/** Adds options to a plugin listed in app.json (by name). */
function withPluginOptions(plugins, name, options) {
  return plugins.map((plugin) => {
    const [pluginName, existing] = Array.isArray(plugin) ? plugin : [plugin, {}];
    return pluginName === name ? [pluginName, { ...existing, ...options }] : plugin;
  });
}

module.exports = ({ config }) => {
  const googleServicesFile = process.env.GOOGLE_SERVICES_JSON ?? './google-services.json';
  const present = existsSync(path.resolve(__dirname, googleServicesFile));
  const iosUrlScheme = reversedClientId(process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID);
  const apsEnvironment =
    process.env.PINGDOST_APS_ENVIRONMENT === 'production' ? 'production' : 'development';
  return {
    ...config,
    android: { ...config.android, ...(present ? { googleServicesFile } : {}) },
    extra: { ...config.extra, apsEnvironment },
    plugins: [
      // First, so its Info.plist mod runs last (after expo-video drops `audio`).
      './plugins/with-ios-background-modes',
      ...withPluginOptions(config.plugins ?? [], 'expo-notifications', {
        mode: apsEnvironment,
        enableBackgroundRemoteNotifications: true,
      }),
      ...(iosUrlScheme ? [['@react-native-google-signin/google-signin', { iosUrlScheme }]] : []),
      // Release builds signed with the upload key from ~/.gradle/gradle.properties (Phase 20).
      './plugins/with-release-signing',
      // Video calls shrink into picture-in-picture (ADR 0037).
      './plugins/with-call-pip',
    ],
  };
};

module.exports.reversedClientId = reversedClientId;
module.exports.withPluginOptions = withPluginOptions;
