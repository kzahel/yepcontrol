# Visible screens that reject remote input

Investigated **2026-11-01**, physically reproduced on an attached Pixel 7a,
Android 17/API 37, Play-installed YepControl **0.11.1/code 13**, and Google
Maps **26.44.03.1006895251**. The client was the production website in isolated
Playwright Chromium. The temporary test pairing was removed and the test browser
closed afterward; the original browser pairing and enabled accessibility services
were preserved, and the phone was returned to Home. Diagnostic artifacts remain
private under ignored `.local/`.

## Observed behavior

- A browser pointer tap opens Maps' account menu from the profile photo.
- The menu remains visible and updates in the viewer. Browser taps on Settings
  and the menu's close button, and a swipe within the menu, have no visible effect.
  The viewer continues to report a connected session without an input error.
- The viewer's Android **Back** action dismisses the menu. A subsequent browser
  tap can reopen it.
- A diagnostic ADB tap at the same Settings position opens Maps Settings.
  A browser tap then opens **About & terms** from Settings successfully.
  No Maps/account preferences were changed.
- A temporary read-only shell UiAutomation probe, configured not to suppress
  existing accessibility services, observes **131 nodes, 126 marked
  `isAccessibilityDataSensitive()`** in the account menu, including its
  full-screen containers. It records only counts and bounds, not account text.
  Its staged helper is removed after use.

This distinguishes an app/Android input restriction from a disconnected viewer
or a general coordinate-mapping failure. The profile/account menu itself is
protected; this result does not establish that every Maps settings page is.

## Explanation and implementation implications

[Android's tapjacking guidance](https://developer.android.com/privacy-and-security/risks/tapjacking)
(reviewed 2026-11-01) documents that, from Android 16/API 36,
`accessibilityDataSensitive` blocks gestures injected with
`AccessibilityService.dispatchGesture` by services not declared accessibility
tools. `filterTouchesWhenObscured` can enable this sensitivity implicitly.
The probe confirms Maps' effective sensitivity; it does not establish which
of these mechanisms Maps used to set it.

YepControl declares gesture/screenshot capabilities in
[`screen_access.xml`](../android/app/src/main/res/xml/screen_access.xml), without
`isAccessibilityTool=true`, and sends browser touch batches through
[`TouchController`](../android/app/src/main/kotlin/dev/remoteaccess/app/control/TouchController.kt).
Android global navigation uses a separate API, explaining why Back remains useful.
Screen visibility and permission to inject input are separate capabilities.

The gesture completion callback reports dispatch completion, not a verified
application action. Current success replies therefore cannot tell the viewer
that a target view discarded a gesture. Browser coordinate or timing changes,
smooth-video changes, and the phone's **Allow unrestricted remote control**
setting do not remove the platform's sensitive-view restriction.

Do not set `isAccessibilityTool=true` as a workaround:
[Google Play restricts that declaration](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en)
to services designed to assist people with disabilities. An explicitly prepared
ADB route has different authority, as this diagnostic comparison demonstrates;
it is not part of the current consumer web-to-host input path.

## Warning feasibility follow-up — 2026-11-01

The owner requested investigation of whether a tap can trigger an accurate
protected-screen explanation. The same Play-installed host was tested through
the existing encrypted CLI snapshot/tap commands, which execute in its actual
ordinary `ScreenAccessService`. No replacement host APK was installed.

| Screen | Nodes exposed by the actual host | Clickable nodes | Observed coordinate-input effect |
| --- | ---: | ---: | --- |
| Maps main screen | 70 | 23 | Profile-photo tap opens the account menu |
| Maps account menu | 1 | 0 | Settings tap returns code 0/Done but leaves the menu open |
| Owned diagnostic canvas with accessibility descendants deliberately hidden | 1 | 0 | Both taps return code 0/Done and independently reach the fixture |

The single exposed menu node is an unlabeled, nonactionable full-screen
`FrameLayout`. Android Back restores the 70-node Maps tree. Repeated snapshots
of the menu remain at one node.

A separate read-only diagnostic used UiAutomation's
[`FLAG_NOT_ACCESSIBILITY_TOOL`](https://developer.android.com/reference/android/app/UiAutomation#FLAG_NOT_ACCESSIBILITY_TOOL),
kept existing accessibility services running, and matched YepControl's view-ID
and interactive-window flags. Android reports `isAccessibilityTool=false` for
that diagnostic. On the menu it observes **one node, zero children, and
`isAccessibilityDataSensitive=false`**. In tool mode, with the same view flags,
it sees 49 nodes, 48 sensitive. These counts differ from the original 131/126
probe because that earlier diagnostic also included views marked unimportant
for accessibility. The ordinary-mode tree agrees with the actual host snapshot.

Thus the sensitive nodes and their flag are hidden from ordinary service
access in this reproduction. Checking the surviving root's sensitivity would
incorrectly classify the protected menu as unrestricted. Sensitive events are
also filtered from non-tool services, as documented by
[`AccessibilityEvent.isAccessibilityDataSensitive`](https://developer.android.com/reference/android/view/accessibility/AccessibilityEvent#isAccessibilityDataSensitive()).

The owned counterexample APK requested no permissions. Its custom canvas was
explicitly nonsensitive, hid its accessibility descendants, and logged native
touch delivery without changing its picture. The actual host saw one node and
zero clickable controls; an independent native log recorded both remote taps.
The captured app image region was identical before and afterward. Consequently,
an empty tree, successful dispatch and no visible change together still do not
prove that Android blocked input. This is a controlled counterexample, not a
claim about the frequency of such screens in other applications.

The temporary named CLI pairing and diagnostic APK were removed after the test.
The original pairing and enabled accessibility services were preserved. Private
receipts remain in ignored `.local/`; no host/viewer implementation or production
deployment was changed.

## Deeper source and provider research — 2026-11-01

The owner rejected the speculative-toast proposal and requested deeper research.
Do not implement that proposal. The following replaces the earlier UX
recommendation with source-level evidence and a concrete stronger-provider lead.

### Where the rejection happens

Source-reviewed Android 17 `frameworks/base` at
[`94b4c163b7dfe5ce3607f7bb8456f9573f7de57d`](https://android.googlesource.com/platform/frameworks/base/+/94b4c163b7dfe5ce3607f7bb8456f9573f7de57d/),
and cross-checked Android 16 release source. These are release branches;
the older `main` source lacks the relevant touch-filter addition and must not
be used to infer current behavior.

1. [`MotionEventInjector.handleMessage`](https://android.googlesource.com/platform/frameworks/base/+/94b4c163b7dfe5ce3607f7bb8456f9573f7de57d/services/accessibility/java/com/android/server/accessibility/MotionEventInjector.java#163)
   forwards the final event, then reports gesture success to the service. It
   does not wait for, or incorporate, the target view's security-filter result.
2. The target application's
   [`View.onFilterTouchEventForSecurity`](https://android.googlesource.com/platform/frameworks/base/+/94b4c163b7dfe5ce3607f7bb8456f9573f7de57d/core/java/android/view/View.java#17031)
   returns false for an accessibility-injected event from a non-tool service
   when the view is sensitive. That branch emits no rejection callback,
   accessibility event, or log message identifying this reason.
3. [`AccessibilityInteractionController.isVisibleToAccessibilityService`](https://android.googlesource.com/platform/frameworks/base/+/94b4c163b7dfe5ce3607f7bb8456f9573f7de57d/core/java/android/view/AccessibilityInteractionController.java#174)
   filters sensitive views for ordinary services. This is why a different
   traversal strategy cannot simply retrieve the missing flag.

The failure is therefore downstream of the service's gesture-completion signal.
It is not an unhandled result that YepControl currently receives but fails to
display. This conclusion is scoped to the reviewed accessibility input path;
it does not say all Android control providers lack the information.

### Additional candidates checked

| Candidate | Evidence | Result |
| --- | --- | --- |
| Include views unimportant for accessibility | Physically tested on the same Pixel, non-tool diagnostic with `FLAG_INCLUDE_NOT_IMPORTANT_VIEWS` | Maps menu exposes five layout containers instead of one. All report nonsensitive; the `android:id/content` container has no exposed children. Protected controls remain hidden. |
| Query all interactive windows | Same physical probe | Active application window and system window metadata provide no protected-region marker. The app's root remains nonsensitive. |
| Distinguish a sparse custom canvas | Same owned APK as the earlier counterexample | Broader queries expose four nonsensitive layout/canvas nodes, with no clickable controls. Better tree coverage helps diagnostics but does not provide a security-rejection result. |
| Motion-event observation / touch-interaction controller | [Public motion callback](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService#onMotionEvent(android.view.MotionEvent)) and [controller contract](https://developer.android.com/reference/android/accessibilityservice/TouchInteractionController) | These observe or classify events before handing them to the application. Their documented callbacks do not report the target's sensitive-view rejection. Touch exploration would also change input behavior. It was not enabled on the phone. |
| Low-level input acknowledgement | [`InputEventSender`](https://android.googlesource.com/platform/frameworks/base/+/94b4c163b7dfe5ce3607f7bb8456f9573f7de57d/core/java/android/view/InputEventSender.java#34) and [`InputManagerService`](https://android.googlesource.com/platform/frameworks/base/+/94b4c163b7dfe5ce3607f7bb8456f9573f7de57d/services/core/java/com/android/server/input/InputManagerService.java#909) | The sender is hidden and bound to its own input channel; cross-app gesture monitoring requires `MONITOR_INPUT`. Neither supplies an ordinary accessibility service with a sensitive-view rejection reason. A generic unhandled bit would also not identify this reason uniquely. |

### Other implementations

Read-only source review; no competitor was installed and no code was adopted:

- RustDesk at
  [`23e5bb471a040d62f0a6ad52591fb30784265b73`](https://github.com/rustdesk/rustdesk/blob/23e5bb471a040d62f0a6ad52591fb30784265b73/flutter/android/app/src/main/kotlin/com/carriez/flutter_hbb/InputService.kt)
  dispatches gestures without a result callback in the reviewed input paths.
  Its reviewed service configuration does not declare `isAccessibilityTool`.
- droidVNC-NG at
  [`44a7d4b52a394253bf3de24bbd1af1c9f265aa44`](https://github.com/bk138/droidVNC-NG/blob/44a7d4b52a394253bf3de24bbd1af1c9f265aa44/app/src/main/java/net/christianbeier/droidvnc_ng/InputService.java)
  tracks gesture completion/cancellation to sequence input. The reviewed path
  contains no sensitive-view rejection reporting; its API-34 configuration
  includes unimportant views but does not declare tool status. These observations
  do not establish every feature or variant of either product.
- Android Remote Control MCP's
  [PR #116](https://github.com/danielealbano/android-remote-control-mcp/pull/116)
  resolves the hidden-tree problem by declaring `isAccessibilityTool=true`.
  The author explicitly distinguishes its sideload distribution from a future
  Play build. It is an example of changing authority, not discovering a missing
  rejection callback. YepControl's existing declaration/Play boundary remains.
- [AnyDesk's official Android guide](https://support.anydesk.com/docs/anydesk-for-android)
  distinguishes universal accessibility control from vendor-specific control
  plugins. Its documentation does not establish a portable blocked-tap detector.

### Trusted-helper experiment and recommendation

**Physically tested:** an ADB-started read-only UiAutomation helper, with its
legitimate test-tool authority and unimportant views included, sees **131 nodes,
126 sensitive** on the Maps menu. At the tested Settings position, **14 visible
sensitive-node bounds contain the point**. The ordinary-mode query of the same
screen sees five nonsensitive containers. A direct ADB tap at that position
opens Maps Settings successfully again. This demonstrates that a trusted
provider can inspect the protection and supply working input on this screen.
The bounds test qualifies this reproduced full-screen protected menu, not a
general hit-testing implementation for every overlapping or clipped view.

The next useful engineering experiment is an **optional ADB-backed input helper**
that keeps YepControl's existing pairing and permission checks. The subsequent
owner-directed review of
[`android-device-access-spike`](sibling-repositories.md#android-device-access-spike-adb-availability-and-recovery)
found an existing native ADB listener-discovery, outbound-bridge and reboot
bootstrap experiment. Its recorded Android-12 Moto acceptance gives this route
a more concrete starting point than a new helper built from scratch. It requires
no Shizuku, but currently runs the ADB client on the controller; preserving
YepControl's browser-only, end-to-end encrypted design still requires client/key
placement work and modern-device qualification. Its accessibility channel does
not add a blocked-tap detector.

On-device packaging through Shizuku remains another candidate, not an implemented or accepted feature.
[Shizuku's official setup guide](https://shizuku.rikka.app/guide/setup/) documents
non-root startup through wireless debugging on Android 11+, with startup needed
again after reboot. This adds real setup and recovery requirements; it cannot
be presented as a transparent fix for every existing Play installation.

For ordinary APK-only control, the reviewed APIs still provide no dependable
per-tap sensitive-view rejection signal. Keep definitive blocked-tap detection
out of that path until there is positive evidence. Do not substitute the
rejected speculative toast or redefine the app as an accessibility tool to
obtain the flag. An upstream API request could ask Android to return a dedicated
security-rejection reason without revealing protected text; no issue was filed
and there is no commitment that Android will add such an API.

No new control provider, app update, or production deployment was made. The
diagnostic APK was removed. Pairings and enabled accessibility services were
preserved. One previously authorized guarded stored-PIN unlock succeeded with
one delivery and no retry; the phone was returned to Home and its initially
locked/sleeping state. Private selectors, credential locators and receipts
remain under ignored `.local/`.

## Subsequent phone-local ADB experiment — 2026-11-01

The owner authorized the bounded experiment described in
[`experiments/local-adb`](../experiments/local-adb/README.md). Its independently
installed app now demonstrates phone-local pairing, an explicitly opted-in
self-grant of `WRITE_SECURE_SETTINGS`, OS-attested shell-helper startup, and
working input on a native sensitive-view fixture. Ordinary accessibility reports
gesture completion while that same fixture independently records no delivered tap.

The complete owned Android-16 emulator run passed three automatic reboot
recoveries at about 28 seconds each, Wi-Fi/helper/listener-loss recovery, orphan
expiry and off-state reboot checks. No desktop pairing or privileged grant was
used. The emulator had no secure PIN; physical Android-17/OEM, first secure
unlock, Doze/overnight and Play qualification remain separate.

This supports a separate, default-off Advanced route without PRoot or a separate
computer for the bootstrap operations. It does not implement blocked-tap
detection for ordinary accessibility. The measured helper ART memory, inactive
ADB-key expiry, dependency licensing and production key storage require follow-up;
see the experiment's results and limits. The released host, browser and relay
have not gained this provider.

The [subsequent physical Moto check](local-adb-phone-spike.md) confirms phone-local
pairing/self-grant and fixes a real Android-12 mDNS resolve race. That firmware
requires a native network-approval repair after reboot because its trusted-network
loader fails; a settings grant alone did not provide unattended recovery. This
older OS does not qualify the original sensitive-view filter, and later USB
transport loss left the physical outage checks and cleanup unfinished.
