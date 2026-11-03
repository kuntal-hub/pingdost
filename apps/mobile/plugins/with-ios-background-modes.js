// The iOS background modes PingDost needs:
// - `voip` and `audio`: PushKit calls and call audio after the screen locks (ADR 0032);
// - `bluetooth-central` and `bluetooth-peripheral`: nearby links, relaying and CoreBluetooth
//   state restoration while the app is in the background, within iOS's limits (ADR 0033).
// expo-video removes `audio` because PingDost plays no video in the background, so this plugin
// must run after it. Expo runs mods in reverse order of registration: app.config.js registers
// this plugin first. `remote-notification` comes from expo-notifications.
const { withInfoPlist } = require('expo/config-plugins');

const MODES = ['voip', 'audio', 'bluetooth-central', 'bluetooth-peripheral'];

module.exports = function withIosBackgroundModes(config) {
  return withInfoPlist(config, (config) => {
    const modes = new Set(config.modResults.UIBackgroundModes ?? []);
    for (const mode of MODES) modes.add(mode);
    config.modResults.UIBackgroundModes = [...modes];
    return config;
  });
};

module.exports.MODES = MODES;
