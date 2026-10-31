# Android release builds for testers (staging)

A release APK signed with **your upload key**, talking to staging. The key and its passwords stay outside the repo (`apps/mobile/plugins/with-release-signing.js` reads them from Gradle properties).

## 1. The upload key (once) — keep it safe
1. Make it outside the repo (PowerShell; `keytool` comes with the JDK Android Studio installed):
   ```powershell
   New-Item -ItemType Directory -Force $env:USERPROFILE\pingdost-keys
   keytool -genkeypair -v -storetype PKCS12 -keystore $env:USERPROFILE\pingdost-keys\pingdost-upload.jks -alias pingdost-upload -keyalg RSA -keysize 2048 -validity 10000
   ```
   Use a long password; the PKCS12 store uses it for the key too.
2. **Back up the `.jks` file and its password** (a password manager plus an offline copy). Losing them means testers must uninstall to get later builds; once on Google Play (Phase 27), Play App Signing can reset an upload key.
3. Tell Gradle where it is: add to `%USERPROFILE%\.gradle\gradle.properties` (create it if missing; it is **not** in the repo):
   ```properties
   PINGDOST_UPLOAD_STORE_FILE=C:/Users/<you>/pingdost-keys/pingdost-upload.jks
   PINGDOST_UPLOAD_STORE_PASSWORD=<password>
   PINGDOST_UPLOAD_KEY_ALIAS=pingdost-upload
   PINGDOST_UPLOAD_KEY_PASSWORD=<password>
   ```
   Never commit the keystore, this file, or the passwords.

## 2. Staging URLs
Copy `apps/mobile/env.production.example` to `apps/mobile/.env.production` (git-ignored) and keep the `api.pingdost.com` values. Release bundles read it; dev builds keep using `apps/mobile/.env`.

## 3. Build
```powershell
$env:JAVA_TOOL_OPTIONS='-Djava.net.preferIPv4Stack=true'
cd apps/mobile
npx expo prebuild --platform android      # applies the signing plugin to android/
cd android
.\gradlew.bat assembleRelease
```
The APK is `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`. Check the signer: `.\gradlew.bat :app:signingReport` → `Variant: release` shows `Config: release` and your keystore. Optional: `google-services.json` in `apps/mobile` for push wakes (Phase 12).

## 4. Hand it to testers
Share the APK (Drive, a direct message); testers allow "Install unknown apps" for that app. Every later APK must be signed with the same key to install as an update.
