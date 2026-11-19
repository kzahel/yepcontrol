# Android TV and Google TV

Android TV uses the same YepControl app and package name, `com.yepcontrol.app`.
The TV launcher opens the same management interface via its Leanback entry
point. Touchscreen, simulated touch, portrait display, camera and microphone
are optional for installation. The portrait override covers the bundled phone
QR scanner activity. TV control requires Android screen-access approval.
Advanced control has separate requirements.

## Pair and control a TV

1. Open YepControl from the TV launcher and choose **Give control → Show code**.
2. Scan the QR code with another device, or open **https://yepcontrol.com/control**
   in the controlling browser and enter the eight groups shown on the TV.
   For the CLI, pass that code through stdin to `yepcontrol pair --from-stdin`.
3. In YepControl Settings on the TV, enable **Screen and control**. Android asks
   you to turn on the YepControl accessibility service. Enable background
   connections and notifications if you want to connect while the app is closed.

On supported hosts, **Remote** in the web viewer opens the directional pad and
playback keys. Arrow keys work while the remote is open. For CLI use
`key up`, `key down`, `key left`, `key right`, `key center` or one of
`play-pause`, `stop`, `next`, `previous`, `rewind`, and `fast-forward`.
The JSON-lines operation is `{"id":"1","op":"key","key":"center"}`.
An updated host reports which keys it supports. Android 13+ exposes D-pad
dispatch through accessibility global actions. Playback commands go to
Android's media session routing and depend on the active app's support.
Both routes use the existing session, local-settings and keyguard gates.
`apps` and `launch PACKAGE` include Leanback launcher activities.

### Pairing authority

The TV creates a 32-symbol code with 160 bits of randomness. The app and
controller derive the relay lookup ID and the existing claim/grant secret
locally using separate SHA-256 labels bound to the configured origin.
The relay receives the lookup ID, public keys, signatures and MACs used by
the existing five-minute, single-use invitation protocol. The code and secret
stay at the endpoints. The receiver treats the TV identity returned by the
lookup as provisional until it verifies the grant MAC, signature and encrypted
device report. The TV verifies the controller's claim MAC and signature
before issuing a grant. The QR on the TV represents the same invitation, so
either presentation can consume it once. Cancel or leave the page to close
the invitation. On TV the QR and code stay under secure-window and explicit
remote input/capture protection, including when unrestricted control is on.
Handheld QR paths and existing grants use their existing formats. See
[phone-first pairing](../phone-first-pairing.md).

### Advanced control

On Android TV 13 or later, enable Android Developer options, start advanced
setup in YepControl, then use **Open Android Developer options** from that
setup page. In Android Settings, turn on **Wireless debugging** and choose
**Pair device with pairing code**. Leave Android's pairing dialog open.
YepControl watches for the local pairing listener for two minutes and puts
a one-minute D-pad keypad over Settings. Enter the six digits shown by Android
and choose **Pair**. The code is entered locally, masked and kept in memory.
This needs **Screen and control** to display the separate accessibility
window. Cancel or Back dismisses the keypad. If it expires or Android issues
a new code, return to YepControl and open Developer options from setup again.
The handheld notification-reply flow remains available on phones. Android,
Wi-Fi and vendor implementations determine availability of Wireless debugging.
See [Android's Wireless debugging prerequisites](https://developer.android.com/tools/adb#wireless).

## Play Console owner steps

Documentation checked 2026-11-19. Use the existing app and signing identity.
The TV release candidate is 0.13.0/code 15. Use the existing signing and
internal-test process.
See [Android signing and internal delivery](android-beta.md).

1. In the main Store listing and other applicable listings, add dedicated
   landscape Android TV screenshots and mention Android TV in the description.
   Prepare at least one real 16:9 TV screenshot at 1920×1080 with private
   codes and device data excluded. The packaged launcher banner is 320×180.
   Play Console requires a separate 1280×720 listing asset. See [preview asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151)
   and [TV app quality](https://developer.android.com/develop/adaptive-apps/quality-guidelines/tv-app-quality).
2. In **Test and release → Advanced settings → Form factors**, use
   **Add form factor → Android TV**, then opt in and accept the TV review
   policy. Decide whether to use the shared release or a dedicated TV track
   before saving that track choice. Play documents that separating an
   existing TV release onto a dedicated track is irreversible.
   See [Play Console form-factor tracks](https://support.google.com/googleplay/android-developer/answer/13295490).
3. Upload the signed TV-capable AAB with all ARM libraries to the applicable
   internal test track. In **Device catalog**, verify the exact 32-bit TV
   model using its Android build device identifier and inspect exclusions.
   Play can group several retail TV models under the same identifier. See
   [Play device targeting](https://support.google.com/googleplay/android-developer/answer/7353455).
   On an authorized TV, install through Play
   as an enrolled tester and exercise pairing, D-pad navigation, connection
   setup and a background request. Coordinate the browser deployment so the
   TV's displayed URL accepts a code. The shared Sony currently has a debug
   signature. Replacing it with the Play-signed app would require uninstalling
   the debug build and pairing again, so use another TV or get separate
   approval for that replacement. See [Android update signing rules](https://developer.android.com/google/play/app-updates).
4. Submit the tested artifact for TV review and rollout after approval from
   the owner. Check submission, TV quality approval, and actual Play Store
   discovery and installation separately. See [Distribute to Android TV](https://developer.android.com/training/tv/publishing/distribute).

## Release status — 2026-11-19

Play Console has the Android TV opt-in on the shared mobile and TV release
track. The English listing has two 1920×1080 TV screenshots, a 1280×720 TV
banner and TV setup copy. App access has dedicated Android TV reviewer
instructions. Managed publishing is off. The last confirmed public Android
version is 0.12.0/code 14.

The [production website and relay](../relay-releases.md#android-tv-viewer--2026-11-19)
accept TV pairing codes and send TV remote commands. This was verified against
the public site using an owned Google TV emulator running code 15. The temporary
pairing was revoked.

The release source is `8813f406f636551550514504867515818bd522dd`.
[Exact-source Checks](https://github.com/kzahel/yepcontrol/actions/runs/44614600918)
pass. An owned Android 16 phone emulator passes local advanced setup, protected
input, helper shutdown after process death, and no boot arming. The local
hosted suites pass browser QR pairing, both CLI pairing directions, media
wake, encrypted video, native input, rotation, and revocation. CI runs the
device, hosted pairing, and hosted control suites independently. All three
passed in the [release run](https://github.com/kzahel/yepcontrol/actions/runs/44614600360).

The signed 0.13.0/code-15 AAB has SHA-256
`824f1816de09696e3a6ec282a3600b918e0d58abea6326921c0b08b8a56fbdc0`.
Bundletool validated those bytes, produced ARMv7 and ARM64 splits, and found
all four native libraries for ARMv7. The splits built from that bundle and
locally signed for testing installed and cold-launched through the Leanback
alias on the owned Android 16 Google TV emulator with 16 KB pages.

The Play API [internal delivery attempt](https://github.com/kzahel/yepcontrol/actions/runs/44621617131)
rejected review deferral at commit. The signed CI bundle was uploaded through
Play Console. Console shows **Available to internal testers** for 0.13.0. Its
release preview reports 2,588 newly supported TV models, for 2,592 total, with
zero models losing support. The only release warning is the missing optional
deobfuscation mapping. Native debug symbols are attached.

After internal publication, Device catalog listed the Sony `BRAVIA_AE_M6L`
with Android 14 and `armeabi-v7a, armeabi` as supported. Play lists BRAVIAs
under their Android device identifiers. Matching the retail identifier
`K-65XR8A` requires the office TV's device identifier. Its exact variant and
Play-installed runtime remain to be verified.

The same code-15 bundle was selected from the Play library for a 100% rollout
in all 178 existing production regions. Play Console received the five-change
review request for the release, description, screenshots, banner, and Android
TV opt-in. Submission activity records **In review** at 22:53 CET. The
automated quick checks finished, and Publishing overview confirmed **Your
changes are now in review** at 23:01 CET. Managed publishing is off. Google
approval and public TV discovery are pending.

## Qualification

The reported baseline was version 0.12.0/code 14 on a 32-bit-only Sony Google
TV, Android 14, 1920×1080 at density 320. The office TV was left alone.

Local 2026-11-19 checks:

- An owned Google TV API 34 ARM64 AVD ran at 1920×1080 and density 320.
  The TV launcher opened YepControl. D-pad checks reached pairing, Activity,
  Allowed browsers, Settings, Connection details, Appearance, About and its
  licenses dialog. Focus survived settings refreshes. The grouped code
  worked through both the CLI and a locally built viewer. The pairing page was
  excluded from OS screenshots. The test used the existing relay and fresh
  emulator-only pairings.
- The encrypted CLI listed and opened the emulator's Leanback-only Settings
  app and moved focus with Up and Down. The browser sent directional and
  playback requests. Browser tests exercise independent D-pad button
  placement and keyboard input at 1440 px and 390 px widths. Playback behavior
  depends on the receiving app's active media session.
- The debug-signed API 34 build registered with FCM, synchronized background
  access with the relay and received a real push after leaving YepControl.
  An encrypted CLI session then connected from the background. The old
  **Retry setup** button appeared regardless of registration state. Debug
  signing alone therefore did not prevent FCM on this test target. The
  Sony's exact FCM setup remains to be checked on its firmware.
- The API 34 Google TV fixture also exercised actual Android Settings over
  emulated Wi-Fi. With Wireless debugging locally approved, the TV keypad
  appeared next to Settings, accepted the system code through D-pad events,
  and the paired advanced helper reached Ready. The test stopped the helper
  when it finished. To repeat, build both APKs, enable screen access and
  Wireless debugging on an owned Google TV AVD, then run
  `TvAdvancedControlTest` with the app's AndroidJUnitRunner. Start the AVD
  with `-no-ethernet` if it otherwise uses Ethernet instead of emulated Wi-Fi.
- The merged release manifest and APK badging had no required TV-incompatible
  features. Bundletool validated the release AAB and produced an API 34
  ARMv7-only split with `libjingle_peerconnection_so.so`, `libyep_pairing.so`,
  `libconscrypt_jni.so` and `libdatastore_shared_counter.so`. The same libraries
  are present on ARM64, x86 and x86-64. All eight 64-bit ELF files use 16 KB
  load alignment, the bundle advertises `PAGE_ALIGNMENT_16K`, and the
  generated ARM64 native split passes `zipalign -c -P 16`. The bundle-derived
  splits, locally signed for testing, installed and cold-launched on a
  Google TV API 36 AVD with 16,384-byte pages.
- The available 32-bit ARM TV emulator images were below the app's minimum
  API level, and the shared Sony was outside the test scope. The ARMv7
  results establish packaging and split selection. Physical ARMv7 runtime
  and Play-installed TV acceptance remain open.
- The TypeScript suite passed 231 tests. Type checking, formatting, release
  Android lint, Kotlin protocol tests, handheld UI acceptance, browser
  layout acceptance and the existing phone-first browser pairing checks
  passed.
