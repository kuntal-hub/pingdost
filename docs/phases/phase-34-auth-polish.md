# Phase 34 — Sign-in and sign-up polish

**Goal:** the account screens feel finished: live username availability, a show/hide password toggle, fields never hidden by the keyboard, error messages that say how to fix the problem, and PingDost's logo and colours.

**Depends on:** 07, 31 (🔄: only its on-phone feel check is open). User request 2026-11-10 (CHANGES; items 1–5 of `prompts/UI_modifications.txt`).

**Read first:** REQ §6.1; ADR 0035, ADR 0039; ARCHITECTURE A10. Code: `apps/mobile/src/app/(auth)/*` and their screens, the server's `modules/auth` routes, the shared username, email and password schemas.

## Tasks
- [x] **Username availability (item 1), server:** `GET /v1/usernames/availability?username=` (ADR 0039: the name is in the query, which request logs leave out) → `{ username, available, reason?: 'taken' | 'reserved' | 'invalid' }`. No sign-in; the same normalisation and reserved names as registration; an unverified sign-up holds its name until it expires, as registration enforces; per-IP limit 120 per 15 min. Tests in `test/auth-register.int.test.ts`.
- [x] **Username availability, phone:** `src/auth/username-availability.ts` (pure, tested) + `use-username-availability.ts` on Register and Google username: 400 ms pause, older requests aborted, answers reused for 60 s, local rule problems shown without a request. Under the field: Checking…, "@name is available", "Taken. Try adding numbers, _ or .", reserved, or "Couldn't check right now" (the submit decides).
- [x] **Password visibility (item 2):** `PasswordField` (`src/components/password-field.tsx`): an eye `IconButton` ("Show password" / "Hide password") inside the field (`TextField` gained `trailing` and a `note` line). On login, register (both fields) and reset password (both fields); no other screen types a password.
- [x] **Keyboard (item 3):** `react-native-keyboard-controller` 1.22.7 (MIT, Expo SDK 58's pin; ADR 0039). `KeyboardProvider preserveEdgeToEdge` at the root; `Screen` is a `KeyboardAwareScrollView` keeping 96 dp under the focused field, so the button after the last field stays visible too. Every screen built on `Screen` gets it (settings forms too). **A new native build is required.**
- [x] **Error messages (item 4):** `src/forms/messages.ts` gives each field a message that says what to change ("Too short: add 2 more characters", "No spaces: try _ or . instead", "Missing the @, as in name@example.com", "The code has 6 digits (4 so far)", "Doesn't match the password above"). A strength meter under new passwords (`PasswordMeter`, `src/auth/password-strength.ts`) rates it and suggests numbers or symbols, a longer phrase, leaving out the username and email, avoiding common words; advice only, the rule stays 10–128 characters. Server codes: "Taken. Try adding numbers, _ or .", and a failed sign-in "That email or username and password don't match. Check both, or reset your password." (never says which).
- [x] **Branding (item 5):** `Screen brand`: the PingDost mark (`BrandMark`, the app icon's artwork) and wordmark over the welcome screen's aurora wallpaper, on Login, Register, Verify code, Forgot and Reset password and Google username; colours from the tokens, so every scheme and dark mode follow.

## Done when
- [x] The availability integration test (11 tests in the file), server unit tests, `pnpm --filter @pingdost/mobile test`, lint and typecheck pass.
- [ ] On a phone (a new build if a native dependency was added): every auth screen with the keyboard open (each field reachable, nothing covered); the eye toggle; Available, Taken and invalid while typing, also on a slow network; each error message; the logo in light, dark and two other schemes.
  - 2026-11-10, **emulator** (Pixel 8, Android 15, new debug APK with keyboard-controller, local server): passed:
    - Register shows the mark and wordmark over the aurora wallpaper;
    - typing `pd_nothing` showed "Taken. Try adding numbers, _ or ." and `pd_nothing_x7` "@pd_nothing_x7 is available" (green border);
    - with the on-screen keyboard up, focusing Confirm password scrolled it and the Create account button above the keyboard;
    - the eye shows and hides the password;
    - the meter showed "Weak · Mix in numbers or symbols, like 7 or #";
    - Login shows the brand header; signing in worked.
  - Fixed during the check: with the password shown, the keyboard offered it as suggestions (and could learn it). Shown passwords now use `keyboardType="visible-password"` on Android.
  - **Open:** the two real phones (Nothing, vivo) with the new APK; the error messages on screen (unit-tested); dark mode and other schemes; a slow network.

## Handoff notes
- The web has no sign-up or sign-in (it pairs by QR code), so this phase is phone-only.
- The native header of the auth stack stays opaque over the wallpaper; a transparent header would look better but changes every auth screen's top inset (later, if wanted).
- An unverified sign-up holds its username until it expires (`UNVERIFIED_ACCOUNT_TTL_SECONDS`), so the owner who goes back and re-registers sees "Taken" for their own name; the submit still succeeds (same email). Acceptable for now.
