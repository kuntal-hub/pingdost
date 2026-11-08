// Picture-in-picture for video calls (ADR 0037): the main activity must declare it, or Android
// refuses `enterPictureInPictureMode` and auto-enter. The activity already handles the size
// changes PiP causes (`screenSize|smallestScreenSize|screenLayout` in Expo's configChanges), so
// shrinking into the window does not restart React Native.
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const CONFIG_CHANGES = ['screenSize', 'smallestScreenSize', 'screenLayout', 'orientation'];

module.exports = function withCallPip(config) {
  return withAndroidManifest(config, (config) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(config.modResults);
    activity.$['android:supportsPictureInPicture'] = 'true';
    const changes = new Set((activity.$['android:configChanges'] ?? '').split('|').filter(Boolean));
    for (const change of CONFIG_CHANGES) changes.add(change);
    activity.$['android:configChanges'] = [...changes].join('|');
    return config;
  });
};
