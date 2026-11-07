# 0035 — "Pop" design system and user-configurable appearance

- **Status:** Accepted
- **Date:** 2026-11-07
- **Phase:** 31
- **Approved by user:** yes (requested the refactor and its requirements; the visual direction was chosen here and is open to change)

## Context
The user asked for the whole UI of the phone and web apps to change: the target is Gen Z and Gen Alpha, and the old look was simple and close to WhatsApp. Requirements: light and dark mode; several color schemes; UI/UX configurable in settings; interactive animations; standard UI/UX guidelines; icons instead of emoji where applicable.

The apps already shared `@pingdost/ui-tokens` with NativeWind and Tailwind, with one fixed green palette and the system light/dark setting.

## Options considered
| Topic | Option | Pros | Cons | License | Cost |
|---|---|---|---|---|---|
| Icons | **Lucide on both** (`lucide-react`, `lucide-react-native` + `react-native-svg`) | Same glyphs on both; per-icon imports keep the bundle small; SVG also draws the wallpapers | New native dependency | ISC, MIT | Free |
| | `expo-symbols` (SF Symbols, Material) | No new dependency | Different icons per platform and none shared with web | MIT | Free |
| Gradients | **RN `backgroundImage`** | Stable style in RN 0.88; no native module | New Architecture only (the app already is) | MIT | Free |
| | `expo-linear-gradient` | Well known | A wrapper view and a native module for nothing extra | MIT | Free |
| Tab bar | **JS tabs + own floating bar** | The sliding pill and "+" are the app's signature | Not the platform's own bar | MIT | Free |
| | `NativeTabs` | Native feel, cheapest | Reads as every other app, which is the complaint | MIT | Free |
| Fonts | **Bundled OFL fonts** (Expo Google Fonts files on the phone, Fontsource on the web) | Personality; self-hosted, so no CDN (CSP and privacy) | About 1 MB in the APK | OFL-1.1, MIT | Free |
| Prefs storage | **One local file (phone), localStorage (web)** | Read synchronously, so the first frame has the right theme; needs no account | Per device | n/a | Free |
| | Synced with the account | Same look everywhere | Sends a behavioral fingerprint to the server for no real need | n/a | Free |

## Decision
1. **One design language, "Pop"**: bold display type, floating pills instead of docked bars, gradient brand fills, squircle avatars with per-person colors, chat wallpapers.
2. **`@pingdost/ui-tokens` is the single source of truth.** Colors (ten schemes in light, dark and pure black), radii and surfaces are CSS variables, so screens keep using classes such as `bg-surface` and `rounded-lg`. `text-primary` became `text-accent`: `primary` is now a *fill* (the default lime has no contrast as text on a light page), and `accent` is the contrast-checked color for text and icons.
3. **Everything is configurable, the same on both apps** (`appearance.ts` in the tokens): mode, pure black, color scheme, look (Soft, Sticker, Outline), bubble shape, wallpaper, font, text size, corners, avatar shape, spacing, motion and, on phones, haptics. Prefs stay on the device; they are not secret, not synced, and survive log out.
4. **WCAG contrast is a unit test** across all schemes and modes (618 cases), so a scheme cannot ship unreadable.
5. **Motion has three levels** (Full, Calm, Off) and the system's "reduce motion" lowers Full to Calm. On the phone it runs on the UI thread (Reanimated CSS transitions and gesture-handler worklets); on the web, CSS and the View Transitions API. Haptics are never the only feedback.
6. **Emoji stay only as content** (reactions, what people type). `attachmentType` and `stateLabel` in `chat-core` return kinds (`kind`, `icon`), and each app draws its own icon, so no emoji leaks into previews.
7. **On the phone all text goes through `@/components/text`**: React Native has no inherited font, so the wrapper applies the font and text size. It reads the usual `text-*` and `font-*` classes; `font-display` is the headline face.

## Consequences
- **A new native build is required** (`react-native-svg`, `expo-haptics`, `expo-font`). An older dev build cannot run this JS.
- `scripts/check-licenses.mjs` allows `OFL-1.1` (OSI approved). The fonts ship unmodified.
- `uiautomator dump` cannot read screens with looping animations (the view never goes idle). UI automation there needs coordinates from screenshots, or Motion set to Calm.
- Spacing classes outside the scale in `ui-tokens` silently produce nothing on the phone: `h-11` collapsed a row of swatches until the scale gained 44. Add a step instead of inventing a class.
- New screens should use the primitives in `apps/mobile/src/components` and `apps/web/src/components/ui`. Do not hardcode colors.
- The app icon was still Expo's template; it is now the PingDost mark (the source is the SVG path in `components/brand.tsx`).

## Evidence
Checked on 2026-11-07 on the `Pixel_8_API_35` emulator and in Chrome, against the local server with real E2EE messages: sign-up, OTP, chat list, sending and receiving, quoted replies, swipe to reply, the long-press sheet, the "+" menu, settings, Appearance (scheme, dark mode, Sticker), persistence across an app restart, and the web app at desktop and 400 px width with no CSP errors. Versions and licenses from npm the same day; `react-native-svg` and `expo-haptics` at the versions in Expo SDK 58's `bundledNativeModules.json`.
