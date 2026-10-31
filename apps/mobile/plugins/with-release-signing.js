// Release signing for the generated android/ project (Phase 20, docs/ops/mobile-release.md).
// The upload key's location and passwords come from Gradle properties, normally in the user's
// own ~/.gradle/gradle.properties: never from this repo. Without them a release build is
// signed with the debug key, as before (fine for local size checks, not for testers).
const { withAppBuildGradle } = require('expo/config-plugins');

const MARKER = 'PINGDOST_UPLOAD_STORE_FILE';

const RELEASE_CONFIG = `        release {
            // PingDost upload key: Gradle properties outside the repo (Phase 20).
            if (findProperty('PINGDOST_UPLOAD_STORE_FILE')) {
                storeFile file(findProperty('PINGDOST_UPLOAD_STORE_FILE'))
                storePassword findProperty('PINGDOST_UPLOAD_STORE_PASSWORD')
                keyAlias findProperty('PINGDOST_UPLOAD_KEY_ALIAS')
                keyPassword findProperty('PINGDOST_UPLOAD_KEY_PASSWORD')
            }
        }
`;

/** The app/build.gradle text with the release signing config; unchanged if already there. */
function applyReleaseSigning(contents) {
  if (contents.includes(MARKER)) return contents;
  const releaseType =
    /(buildTypes \{[\s\S]*?release \{\n(?:[ \t]*\/\/.*\n)*)([ \t]*)signingConfig signingConfigs\.debug/;
  if (!releaseType.test(contents) || !/signingConfigs \{\n/.test(contents)) {
    throw new Error('with-release-signing: app/build.gradle no longer has the expected layout');
  }
  return contents
    .replace(
      releaseType,
      `$1$2signingConfig findProperty('${MARKER}') ? signingConfigs.release : signingConfigs.debug`,
    )
    .replace(/signingConfigs \{\n/, (start) => start + RELEASE_CONFIG);
}

const withReleaseSigning = (config) =>
  withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = applyReleaseSigning(mod.modResults.contents);
    return mod;
  });

module.exports = withReleaseSigning;
module.exports.applyReleaseSigning = applyReleaseSigning;
