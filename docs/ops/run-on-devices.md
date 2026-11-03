# Run PingDost on the emulator and on your phones

A step-by-step guide for testing chat yourself on the Android emulator, one phone, or several
phones at once. Every command is for **Windows PowerShell**, run from the repo folder
`C:\Users\Km799\OneDrive\Desktop\pingdost` unless a step says otherwise.

## How it fits together

```
 Your PC                                          Each phone / the emulator
 ┌──────────────────────────────────────────┐     ┌──────────────────────────────┐
 │ Docker: Mongo, Valkey, Mailpit (:8025)   │     │ PingDost dev build (APK)     │
 │ API server            :3000  ◄───────────┼─────┤ sends and receives messages  │
 │ Metro (the app's code):8081  ◄───────────┼─────┤ loads the app's code         │
 └──────────────────────────────────────────┘     └──────────────────────────────┘
                         Wi-Fi (mode A)  or  adb: USB / wireless debugging (mode B)
```

- The **dev build** (APK) contains only the native part of the app. Every time it starts, it
  loads the app's code from **Metro** on your PC, and it sends messages through the **API
  server** on your PC. So each device needs a connection to your PC while you test. That is
  true for an EAS build and for a local build alike.
- **EAS only changes how you install the APK.** A phone downloads it from the EAS build page in
  its browser, with no cable and no USB debugging.
- Code edits show up on every device at once, with no new APK.
- The same APK runs on phones (arm64) and on the emulator (x86_64).

## 1. Get the APK

### From EAS (cloud build)
The build runs on Expo's servers, so your PC can be off while it builds.

1. Open https://expo.dev/accounts/kuntal-hub/projects/pingdost/builds (log in as `kuntal-hub`).
   The first build is `b49d1ee0-ccbf-4471-b025-75b161a05257`.
2. Wait for the status to show **Finished**. Free-plan builds wait in a queue, sometimes for
   an hour or more.
3. **On each phone:** open that page in the phone's browser (log in), open the build, tap
   **Install**, and download the APK. You can also scan the QR code shown on the page from
   your PC with the phone. Android asks you to allow installs from the browser: allow it,
   then tap the downloaded file to install.
4. **For the emulator:** on the PC, click the build → **Download** (or ⋮ → Download build), and
   save it as `C:\Users\Km799\Downloads\pingdost-dev.apk`.
5. If the status is **Errored**, open the build, copy the link, and send it to Claude.

Check from the terminal instead:
```powershell
cd apps\mobile
npx eas-cli@27.3.0 build:list -p android --limit 3
cd ..\..
```

### When you need a new APK
Only after **native** changes: `app.json` plugins, a new native package, the Kotlin modules in
`apps/mobile/modules`, or the Rust crypto library. JS and TS changes never need one.
```powershell
# Only if the Rust crate changed (needs Rust and cargo-ndk, see CLAUDE.md):
$env:ANDROID_NDK_HOME = "$env:ANDROID_HOME\ndk\27.1.12297006"
pnpm --filter @pingdost/crypto-native build:android

cd apps\mobile
npx eas-cli@27.3.0 build -p android -e development --no-wait
cd ..\..
```
The Free plan gives 15 Android builds per month and never charges you. Install the new APK over
the old one; the app's data stays.

### Without EAS (local build, about 15+ minutes)
`pnpm --filter @pingdost/mobile android` builds and installs over USB on the one attached
device. A local build contains only that device's ABI, so a phone build crashes on the
emulator. For the emulator, run `npx expo run:android --no-bundler --device emulator-5554` in
`apps\mobile`. Set `$env:JAVA_TOOL_OPTIONS='-Djava.net.preferIPv4Stack=true'` first. The
one-time Windows setup is in CLAUDE.md (ADR 0005).

## 2. Choose how devices reach your PC

Pick **one** mode per session. `apps\mobile\.env` tells the app where the server is, and it
has to match the mode.

| | **A. Wi-Fi** (recommended) | **B. adb** (USB cable or wireless debugging) |
|---|---|---|
| USB cable / USB debugging | Not needed | Needed (wireless debugging also works) |
| Number of phones | Any | As many as you can connect over adb |
| Network | Phones and PC on the **same Wi-Fi**, which you mark **Private** on the PC | Any network, even Public ones or none |
| `apps\mobile\.env` | The PC's Wi-Fi IP | `127.0.0.1` |
| Redo when | Your PC's IP changes (another network) | A device reconnects or reboots |

On this PC, `.env` is set to `127.0.0.1` (mode B) right now.

## 3. Start the PC side (every session)

Use **three PowerShell windows**, each in the repo folder.

**Window 1: databases and mail** (start Docker Desktop first and wait until it says running)
```powershell
pnpm infra:up
```

**Window 2: API server** (keep it open)
```powershell
pnpm --filter @pingdost/server dev
```
Check it from window 1: `curl.exe http://127.0.0.1:3000/readyz` should print
`{"status":"ok",...}`.

**Window 3: Metro** (keep it open). In mode A, run the `$env:` line from section 4A first.
```powershell
pnpm --filter @pingdost/mobile start --clear
```
`--clear` is needed only after you change `apps\mobile\.env`, but it is harmless otherwise.

## 4A. Mode A: Wi-Fi (no cable)

**Once per network:**
1. Connect the PC and every phone to the same Wi-Fi.
2. On the PC, mark that network **Private**: Settings → Network & internet → Wi-Fi → your
   network → Network profile type → **Private**. Windows already allows Node.js on Private
   networks. Do this only on a network you trust (home, your own hotspot), not in a café.
3. Find the PC's Wi-Fi IP:
   ```powershell
   (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'Wi-Fi').IPAddress
   ```
4. Open `notepad apps\mobile\.env` and set both lines to that IP (example `10.178.91.244`):
   ```
   EXPO_PUBLIC_API_URL=http://10.178.91.244:3000
   EXPO_PUBLIC_WS_URL=ws://10.178.91.244:3000/v1/ws
   ```
5. Check from a phone: open `http://<PC IP>:3000/readyz` in the phone's browser (with the
   server running). It should show `{"status":"ok",...}`. If it doesn't load, see
   Troubleshooting.

**Every session:** start Metro (window 3) with the IP, so its QR code points at the right
address:
```powershell
$env:REACT_NATIVE_PACKAGER_HOSTNAME = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'Wi-Fi').IPAddress
pnpm --filter @pingdost/mobile start --clear
```

**Open the app on each phone:** scan the QR code in the Metro window with the phone's camera.
It opens PingDost and loads the app. Or open PingDost and, in the dev launcher, tap **Enter URL
manually** → `http://<PC IP>:8081` → **Connect**. The phone remembers it next time.

**The emulator in mode A:** start it (see 4B), drag the APK file onto the emulator window to
install it, open PingDost, and enter `http://<PC IP>:8081`. The emulator reaches the PC's IP
like a phone does.

## 4B. Mode B: adb (USB cable or wireless debugging)

`adb reverse` makes `127.0.0.1:3000` and `127.0.0.1:8081` on the device point at your PC. Set
`apps\mobile\.env` to:
```
EXPO_PUBLIC_API_URL=http://127.0.0.1:3000
EXPO_PUBLIC_WS_URL=ws://127.0.0.1:3000/v1/ws
```

**Prepare each phone (once):**
1. Settings → About phone → tap **Build number** 7 times ("You are now a developer").
2. Settings → System → Developer options → turn on **USB debugging**.
3. Connect by USB and tap **Allow** on "Allow USB debugging?". Tick "Always allow from this
   computer". `adb devices` should list the phone as `device`.
4. No cable? Use **wireless debugging** (Android 11+, same Wi-Fi; works on a Public network
   because the PC connects out to the phone): Developer options → **Wireless debugging** → on
   → **Pair device with pairing code**. On the PC, run `adb pair <IP:port shown>` and enter
   the code, then `adb connect <IP:port on the Wireless debugging screen>` (a different port).

**Start the emulator** (run at most **one**, because this PC runs out of memory with two):
```powershell
Start-Process "$env:ANDROID_HOME\emulator\emulator.exe" -ArgumentList '-avd','Pixel_8_API_35'
```
Or use Android Studio → Device Manager → ▶.

**Connect every attached device** (emulator and phones together). This also installs the APK.
Leave out the `install` line if the app is already on the devices:
```powershell
$apk = "C:\Users\Km799\Downloads\pingdost-dev.apk"
adb devices | Select-String "`tdevice$" | ForEach-Object {
  $id = ($_ -split "`t")[0]
  "--- $id"
  adb -s $id install -r $apk
  adb -s $id reverse tcp:8081 tcp:8081
  adb -s $id reverse tcp:3000 tcp:3000
}
```
Run it **again** whenever a device reconnects, reboots, or the emulator restarts.

If install fails with `INSTALL_FAILED_UPDATE_INCOMPATIBLE` (a local build with another signing
key is on the device), run `adb -s <id> uninstall com.pingdost.app` and install again. This
deletes that device's PingDost data.

**Open the app:** tap PingDost → **Enter URL manually** → `http://127.0.0.1:8081` →
**Connect**. Or press **`a`** in the Metro window (**Shift + A** to choose the device).

The first load takes a minute while Metro bundles. Press **`r`** in the Metro window to reload
the app on all devices.

## 5. Test chat between two devices

Mailpit catches every email the server sends, so any address works, even made-up ones like
`alice@test.local`.

1. **Device A:** Create account → enter a username (for example `alice`), an email and a
   password → **Create account**.
2. On the PC, open **http://localhost:8025** (Mailpit), open the newest email, and copy the
   code. On device A, enter it under "Check your email" → **Verify**.
3. **Device B:** do the same with another username and email (for example `bob`).
4. **Device A:** Chats → the **+** button (bottom right) → Username: `bob` → **Message**. Type
   a message and send it. It appears on device B.
5. Try these too:
   - **Replies, read receipts and typing:** reply from B; watch the ticks and the typing
     indicator on A.
   - **Offline delivery:** swipe PingDost away on B (or turn on airplane mode in mode A), send
     from A, then reopen B. The message arrives.
   - **Photos, voice notes, groups, calls:** use the attach button, the mic button, Chats →
     **+** → New group, and the call buttons in a chat. For calls, see "Calls" in CLAUDE.md
     (coturn).

**Only one device?** Start a headless test contact in a fourth window:
```powershell
pnpm --filter @pingdost/sim-client peer
```
It prints its username. Start a chat with it from the app: it shows online, sends read
receipts, types, and echoes every message. Messages starting with `!react`, `!edit` or
`!delete` make it react, edit or delete its echo.

## 6. Stop everything

1. In the Metro and server windows, press **Ctrl + C**.
2. Stop the emulator: `adb -s emulator-5554 emu kill` (or close its window).
3. Stop the databases: `pnpm infra:down`. Your data is kept in Docker volumes for next time.
4. Quit Docker Desktop if you like. Then you can shut down the PC.

## 7. Troubleshooting

| What you see | Fix |
|---|---|
| Mode A: the phone can't open `http://<PC IP>:3000/readyz` | Check that the network is **Private** on the PC, that the phone is on the same Wi-Fi (not mobile data), and the IP is current. Some networks (hotels, offices, some routers' "guest" Wi-Fi) stop devices from seeing each other: use mode B there. |
| Mode A: the QR code opens but loading fails | Metro picked the wrong address (Docker or WSL adapters). Start Metro with the `$env:REACT_NATIVE_PACKAGER_HOSTNAME` line, or enter the URL manually. |
| Mode B: "Could not connect" or "Unable to load script" | Metro isn't running, or the device lost `adb reverse tcp:8081 tcp:8081`. Run the connect block again. |
| The app shows an offline banner or "You seem to be offline" | The server isn't running, or the device can't reach port 3000: in mode A, check `readyz` from the phone; in mode B, run the connect block again. |
| The app still uses the old address after editing `.env` | Restart Metro with `--clear`. |
| No email in Mailpit | Run `pnpm infra:up`, and make sure the server window shows no errors. |
| `adb devices` shows nothing or `unauthorized` | Use a data USB cable (not charge-only), unlock the phone, and accept the prompt. Try `adb kill-server; adb devices`. |
| The emulator freezes or the PC slows down | Close other apps and run only one emulator. Docker, Metro and the server use a lot of RAM. |
| The server loses Mongo after Docker restarts | This PC also runs a Windows MongoDB service on `127.0.0.1:27017`. Restart the server window. For a permanent fix, in an **admin** PowerShell run `Stop-Service MongoDB; Set-Service MongoDB -StartupType Disabled`. |
| Red error screen in the app | Read the message, fix the code, and Metro reloads. Press `r` in the Metro window to force a reload. |
| Crash right at start on the emulator | You installed a local phone build (arm64 only). Install the EAS APK, or build for the emulator (section 1). |
