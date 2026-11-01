# Android capabilities and reliability

Reviewed 2026-10-18. **Platform documentation and sibling evidence, not a device
acceptance result for this product.** Sources are catalogued in
[the research ledger](../research/SOURCES.md). Android release, target SDK,
OEM firmware and the particular app being controlled all matter.

## What the pieces can actually provide

| Need | Candidate mechanism | What it does not establish |
| --- | --- | --- |
| Observe accessible UI | User-enabled AccessibilityService | Complete trees, private app data, protected views or arbitrary secure screenshots |
| Tap/swipe/navigate | Accessibility gestures/global actions; shell input through prepared ADB | Permission to operate every app/auth surface or evidence the action succeeded |
| Capture still frames | Accessibility `takeScreenshot` from API 30; window capture from API 34 | Continuous video, access to secure content or consistent lock-screen capture |
| Capture video | User-consented MediaProjection; shell-owned hardware capture via an ADB route | Permanent capture consent, automatic restart after screen lock or reboot |
| Wake the app process | FCM or another allowed background entry point | Display wake, secure unlock or authority to start every foreground-service type |
| Maintain transport | Outbound WebSocket/QUIC or another session transport, with a relay | Immunity to Doze, process death, force-stop or lack of Internet |
| Wake the display | Appropriate visible activity/power APIs; authorized shell input | Dismissing a secure keyguard or decrypting credential-protected storage |
| Dismiss keyguard | `KeyguardManager.requestDismissKeyguard` | Bypassing a PIN/password when Android requires credentials |
| Enter a known PIN | Candidate prepared shell input; possibly permitted interactive input on some configurations | Root, credential recovery, bypassing lockout or universal OEM compatibility |
| Sustain background work | Correct foreground service, user battery choice, specific valid exemptions | An app that cannot be stopped or unrestricted access to camera/microphone |
| Companion-device presence | A real CDM association and applicable permissions | A general Internet-peer keepalive permission |

“Needs ADB for unlock” is a **hypothesis about our practical recovery route**,
not an Android-wide theorem. An ordinary app cannot bypass a secure credential.
Whether manually entering a known PIN through accessibility works on any target
configuration must be tested; it is especially unsafe to assume protected auth
screens accept accessibility input. ADB is a stronger candidate but has its own
authorization, listener and post-boot limits.

## Accessibility: promising baseline with consequential limits

[AccessibilityService](https://developer.android.com/reference/android/accessibilityservice/AccessibilityService)
provides semantic observations, actions, gesture dispatch and screenshots when
the user enables the service and it declares the relevant capabilities. Gesture
dispatch is available from API 24; display screenshots from API 30 and window
screenshots from API 34. Screenshot APIs are rate-limited and can refuse secure
windows; a service is not an unrestricted framebuffer or a high-frame-rate codec.

The MC resident experiment demonstrates local fixture-scoped semantic actions
and window PNG capture on a physical phone. It does not qualify arbitrary
personal apps, generic gesture control, protected credentials, remote access or
survival after reboot. The [sibling map](sibling-repositories.md) links its exact
evidence boundaries.

[Android's security guidance](https://android-developers.googleblog.com/2025/12/enhancing-android-security-stop-malware.html)
explains `accessibilityDataSensitive`: on Android 16, sensitive views can deny
data access and interactions to services not declared legitimate accessibility
tools. It warns that falsely setting `isAccessibilityTool=true` can lead to
Play rejection and Play Protect blocking. A consumer remote-access app must
not claim disability-tool status just to reach a login screen. This affects the
auth-repair use case directly, rather than being a theoretical edge case.

**Physically reproduced 2026-11-01:** Maps' account menu remains visible but
rejects YepControl's browser gestures on Android 17. A read-only native probe
confirms sensitive UI nodes; Android Back works, and a diagnostic ADB tap opens
Settings, where browser input works again. See the
[sensitive-screen investigation](sensitive-screen-input.md) for versions,
evidence and the distinction between gesture completion and application effect.

[Play's accessibility policy](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en)
does not categorically prohibit non-disability apps using the API. It requires
declaration/review and prominent disclosure/consent for applicable apps, and
prohibits autonomous initiation/planning/execution outside the qualifying tool
exception. Human-directed remote control is a different case from an AI choosing
actions. That distinction makes a manual product worth investigating; it does
not constitute approval of our future APK or every operation it might expose.

## Screen video and why lock is a large problem

The [MediaProjection guide](https://developer.android.com/media/grow/media-projection)
requires user consent before a projection session. For apps targeting Android
14+, a consent token cannot be reused to create multiple capture sessions, and
the appropriate media-projection foreground-service declaration is required.

On **Android 15 QPR1+**, projection automatically stops when the screen locks.
A projection stopped by Android must release resources and update state. It is
not just a temporary black video frame that can be assumed to recover remotely.
The foreground-service guide also restricts launching media-projection services
from `BOOT_COMPLETED` for apps targeting Android 15+.

Therefore “enable screen recording once and reconnect forever” is not a viable
general baseline. Investigate accessibility still frames and a prepared
shell-owned capture route separately. Vendor-documented `PROJECT_MEDIA` app-op
workarounds are version-sensitive claims, not a supported portable override of
all modern Android restrictions.

Camera streaming is a different capability from screen sharing. Camera and
microphone foreground services have while-in-use permission restrictions;
receiving a push does not automatically authorize starting them in the background.
Using an existing camera app through remote control also inherits that app's
lifecycle and capture restrictions.

## Lock, known-PIN entry and optional preparation

[KeyguardManager](https://developer.android.com/reference/android/app/KeyguardManager#requestDismissKeyguard(android.app.Activity,%20android.app.KeyguardManager.KeyguardDismissCallback))
documents that dismissal can complete without interaction if the keyguard is
not secure or the device is trusted. Otherwise it displays credential-entry UI.
ADB authorization is distinct from that authentication.

A prepared shell route can inject input on supported devices; it still needs
the correct PIN. Shell UID is not root, does not expose arbitrary app-private
storage and does not defeat biometric-only flows. A successful injection call
does not prove keyguard or first-unlock state changed. MC's existing guarded
implementation checks conditions, submits once through private stdin and
independently observes effect; its real correct-PIN acceptance remains open.

Before adopting this route, resolve:

- Does the app have its own authorized ADB key, and does it target this exact
  phone? A computer's USB authorization is not inherited by the app.
- Is this classic USB-armed TCP adbd, modern paired wireless debugging, a
  Shizuku-style broker, or an attached computer maintaining the connection?
  They have different lifetime and security properties.
- Can the listener/broker survive network changes, process loss and reboot?
  Which step needs a person or computer to re-arm it?
- Is the operation allowed on this OEM, Android/target version and lock screen?
  Does managed-device policy forbid input or impose wipe/lockout rules?
- After reboot, can the process run and access the exact required key/PIN
  material before the first unlock? Avoid a circular recovery dependency.

[ADB documentation](https://developer.android.com/tools/adb) describes Android
11+ wireless pairing and older USB-bootstrapped TCP access. Its current Android
17/ADB 37 Wi-Fi 2.0 documentation describes trusted-network reconnection; that
is worth testing, not proof of unattended first-unlock recovery.
[Shizuku's setup guide](https://shizuku.rikka.app/guide/setup/) documents phone-only
wireless startup on Android 11+ and the need to repeat non-root startup after
reboot. Neither approach is an adopted dependency here.

Keeping an already-unlocked phone charging with “stay awake” reduces the chance
of automatic timeout; it does not disable secure locking, survive unplugging or
prove post-boot recovery. scrcpy distinguishes [stay awake and display power](https://github.com/Genymobile/scrcpy/blob/a60891aea193d92e7e5c3942700eca63f9d19a5f/doc/device.md).
Turning the panel off while an ADB session retains interaction is not equivalent
to Android securely locking the device.

Saving a PIN would be an explicit advanced option, not an initial requirement.
It needs native protected storage, backup exclusion, Forget, no logging/URLs/
argv/browser retention, one-attempt delivery and an independent unlock result.
A key requiring fresh local biometric authentication may defeat unattended use;
a key readable before first unlock has a different risk and feasibility profile.
Keystore encryption alone does not resolve which local process may use the PIN.

## FCM and a persistent relay connection solve different problems

[FCM priority documentation](https://firebase.google.com/docs/cloud-messaging/android-message-priority)
says normal messages can be delayed in Doze. High priority attempts timely
delivery and grants limited processing/network time. It is intended for
time-sensitive user-visible content; a pattern of silent high-priority messages
can be downgraded or delegated. Do not use high priority as an indefinite silent
keepalive. Notification denial/delegation and Google Play services availability
need their own tests.

A reasonable **candidate** is push as an authenticated wake hint, followed by
an outbound authenticated session connection when permitted. The push token is
not remote-control authority. Push payloads should not contain PINs, arbitrary
shell commands, screenshots or reusable control credentials. A generic visible
“remote access requested/active” notification can explain the activity, but its
presence alone does not establish policy eligibility or service-start authority.

A persistent outbound WebSocket can provide quick session establishment while
the process is permitted to run. [Doze](https://developer.android.com/training/monitoring-device-state/doze-standby)
suspends ordinary network access and ignores ordinary wake locks; merely holding
a socket does not prevent it. Battery-optimization exemption provides some
network/partial-wake-lock relief, not immunity to every background restriction
or OEM process killer. Charging helps but is not a guarantee.

FCM versus WebSocket is consequently not necessarily an either/or decision:

| Operating state | Candidate behavior | What remains uncertain |
| --- | --- | --- |
| Active viewing | Session transport carries encrypted media/input; push unnecessary | Bandwidth, latency, heat, service type and network handoff |
| Enabled, idle, process alive | Low-work control connection or disconnect with push wake | OEM/Doze impact and battery cost |
| Process reclaimed | FCM may provide an allowed entry point | Priority, notification settings, service-start restrictions |
| User force-stopped app | Treat as requiring explicit recovery; do not promise push restart | Product support policy and exact tested OS behavior |
| Reboot before first unlock | Direct Boot-aware design may receive limited messages | Credential storage, capture/input readiness and app/ADB startup |
| Device without Google services | No assumption that the normal FCM route exists | A separately designed non-GMS service/transport path |

[Direct Boot FCM](https://firebase.google.com/docs/cloud-messaging/customize-messages/android-direct-boot)
exists with explicit app/message configuration and device-protected operation.
This prevents the overclaim that “nothing can receive before unlock.” It does
not make credential-encrypted app data, capture consent or an ADB service ready.
[Android 15 stopped-state changes](https://developer.android.com/about/versions/15/behavior-changes-all)
and [foreground-service Task Manager stop](https://developer.android.com/develop/background-work/services/fgs/handle-user-stopping)
must be tested separately from ordinary process reclamation. Do not try to
silently defeat an owner's decision to stop access.

## Background, companion and nearby-device permissions

“Background/peer permission” is not a single Android authority. The relevant
facilities have distinct scopes:

- [Foreground-service types](https://developer.android.com/develop/background-work/services/fgs/service-types)
  describe real work. `remoteMessaging` means text-message continuity, not any
  traffic to a remote peer. `connectedDevice` covers qualifying external-device
  interaction; it does not replace the appropriate projection type.
  `specialUse` needs an explained case reviewed in Play Console, rather than
  being a universal escape hatch.
- [Background-start exemptions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
  include particular high-priority FCM, battery and companion cases, but
  while-in-use camera/microphone requirements remain separate. An Android 15+
  overlay-based exemption requires a currently visible overlay as well as the
  permission; requesting “display over apps” alone is not enough.
- [CompanionDeviceManager](https://developer.android.com/develop/connectivity/bluetooth/companion-device-pairing)
  associates a real Bluetooth/BLE/Wi-Fi companion. Permissions include
  `REQUEST_COMPANION_RUN_IN_BACKGROUND`,
  `REQUEST_COMPANION_USE_DATA_IN_BACKGROUND` and
  `REQUEST_COMPANION_START_FOREGROUND_SERVICES_FROM_BACKGROUND`. Association,
  applicable profile, presence and permissions must be genuine. A remote
  browser over the Internet does not automatically qualify as a nearby companion.
- [BLE background guidance](https://developer.android.com/develop/connectivity/bluetooth/ble/background)
  and CDM presence may be relevant if the phone really connects to the power
  station. The battery's protocol and profile still need investigation; do not
  fabricate a companion association solely for keepalive.
- Bluetooth/nearby-device permissions authorize particular discovery and
  communication. They are not a general grant to survive Android background
  management or read another app's Bluetooth data.

## Network and security shape to investigate

An outbound relay fallback is important for RV/carrier NAT. Direct WebRTC can
be an optimization, but STUN-only connectivity is not sufficient evidence for
universal Internet access. Compare TURN media relay, an encrypted application
relay and a VPN-assisted advanced mode; account for mobile data and server cost.
Tailscale can solve reachability for technical users but does not solve Android
capture consent, local process lifetime or secure unlock.

Separate pairing/discovery, viewer identity, target-side authorization and
transport. Encrypt screen/input content end to end if the chosen design claims
relay privacy; HTTPS to the relay alone is not that guarantee. Use short-lived
session authority, replay protection, explicit local disablement and viewer
revocation. Capture/input must stop when ownership ends. Auth repair must not
depend on the very app/provider authentication it is repairing.

## Experiments that would resolve the main unknowns

This list initially proposed experiments; it does not authorize new device work.
The later [emulator spike](spike.md#results) now supplies bounded evidence for
capture/input, secure lock, known-PIN delivery and lifecycle on its tested images.
It does not complete this wider physical-device validation matrix. Use disposable fixtures and explicit device selection.

1. **Capture/input:** qualify an accessibility frame and a MediaProjection
   session across lock/unlock, sensitive views, orientation and service restart;
   compare a prepared shell route. Include Android 15 QPR1+/16 and one older
   spare phone. Record target SDK and OEM, not just Android marketing version.
2. **Unlock:** with a synthetic known credential and supervision, observe wake,
   credential UI, exactly one delivery and independent keyguard/user-storage
   state. Test same-phone ADB identity and re-arm requirements. No secrets in
   logs, screenshots, argv or retained evidence.
3. **Wake:** distinguish process reclamation, Doze, screen lock, task swipe,
   Task Manager Stop, Settings force-stop and reboot. Test FCM priority and
   notification denial; never use one scenario as evidence for another.
4. **Connectivity:** complete the RV battery-app-like task over different
   networks/carrier NAT with direct media deliberately unavailable, then after
   Wi-Fi/mobile handoff. Measure relay fallback and data cost.
5. **Reliability:** measure screen-off/overnight availability, plugged/unplugged,
   OEM battery settings and updates. Use bounded reconnect and no idle capture.
6. **Human input:** test real sequential typing, Unicode/composition and cursor
   edits while frames/status update. Local input acknowledgement should be
   within 100 ms; network round trips are a separate measurement. Whole-field
   replacement tests are not evidence for keystroke responsiveness.

The product should expose these measured capability boundaries rather than
compressing all of them into one “Online” indicator.
