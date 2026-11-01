# Relevant sibling repositories

Initial read-only review, 2026-10-18; dated additions appear below. Paths are relative to this checkout's expected
parent (`~/code`); use them as navigation, not installed-product requirements.
No sibling was modified for this research. Working trees may contain newer,
uncommitted work; revision pins identify the committed baseline only.

| Sibling | Reviewed baseline | Relevant material | Reuse boundary |
| --- | --- | --- | --- |
| [machine-control](../../machine-control/) | `9b0c532` | Android ADB adapter, protected known-PIN route, resident accessibility spike, native operation/grant lifecycle | Most relevant source of reusable device primitives; its agent interface and desktop product need not become this product's UX |
| [yepanywhere](../../yepanywhere/) | `c52e07e39` | Android-host lifecycle, native setup, provider-auth recovery use case, encrypted remote access, device streaming and push broker | Inspiration/components only; this product is not a YA feature and does not need its provider runtime |
| [jstorrent](../../jstorrent/) | `fe4be51c` | Standalone native Android product, foreground/background lifecycle, remote access/pairing and hosted controller UX | Study concrete product/setup lessons, permissions and lifecycle; do not import the torrent engine |
| [agent-auth-router](../../agent-auth-router/) | `263bbf2` | Inference authentication infrastructure and the failure mode that motivates manual repair | Context only; no inference service should be a runtime prerequisite |
| [web-server-chrome](../../web-server-chrome/) | Unpinned orientation reference | Android bootstrap, simple user-facing server setup and private native bridging | Candidate for a focused later source review; no implementation acceptance claimed here |
| [android-device-access-spike](../../android-device-access-spike/) | `e7c42ad` (2026-11-01 review) | Native outbound bridge to system `adbd`, listener discovery, optional bootstrap grant and documented Moto reboot recovery | Laboratory transport/controller, not a production YepControl integration; see the review below |

## Android device access spike: ADB availability and recovery

Cloned at the owner's request and source-reviewed **2026-11-01** at
[`e7c42adb888b037ee6b64589e6a100f2e89d0ff3`](https://github.com/kzahel/android-device-access-spike/tree/e7c42adb888b037ee6b64589e6a100f2e89d0ff3).
Its 30 transport/control/fixture-boundary tests passed locally with
`uv run --script spike.py test`. The cloned working tree remains unchanged.
No phone operation or new physical acceptance was performed for this review.

The most relevant pieces for YepControl's
[protected-screen input investigation](sensitive-screen-input.md) are:

- [`WirelessAdb`](../../android-device-access-spike/android/app/src/main/java/fit/tom/deviceaccess/spike/WirelessAdb.java)
  discovers the current `_adb-tls-connect._tcp` listener, verifies that its
  advertised address belongs to the phone, and makes the bridge use loopback.
  With explicit bootstrap opt-in and a provisioned `WRITE_SECURE_SETTINGS`
  grant, it requests `adb_wifi_enabled` after Wi-Fi is available. This is a
  shell-granted development permission, not an ordinary runtime consent.
- [`TunnelService`](../../android-device-access-spike/android/app/src/main/java/fit/tom/deviceaccess/spike/TunnelService.java)
  carries an existing system `adbd` socket over an authenticated outbound WSS
  connection. It needs no Shizuku, PRoot or phone-local ADB server.
- The [qualification record](../../android-device-access-spike/docs/architecture.md)
  reports three USB-free, untouched reboots on a Moto G Power (2022), Android 12,
  with screen lock disabled by its owner and explicitly enrolled access points.
  Usable ADB returned in 126/131/129 seconds, followed by transfer, capture,
  native tap and drag/drop acceptance. A separate credentialed-device run needed
  one manual unlock. These are that repository's recorded physical results,
  not a new reproduction or qualification of the Pixel/Android 17.

This is a concrete candidate for the ADB availability/bootstrap layer. Its
accessibility gesture path still uses the ordinary completion callback and
does not provide a sensitive-view rejection detector. The stronger input route
comes from ADB, not a new accessibility capability.

The spike runs the ADB client on the controller, exposed through a local TCP
connector. A YepControl browser-only implementation still needs an explicit
choice of ADB client placement and key custody. A native phone-local ADB client
could keep execution and keys on the phone while retaining YepControl's existing
encrypted commands; that is a proposal, not code implemented by this spike.
Putting ADB on a hosted gateway introduces a different trust boundary. Do not
replace YepControl's paired, end-to-end encrypted protocol with the laboratory's
shared role secrets or its relay-terminated accessibility channel.

Modern Android startup, network-approval screens, first unlock, distribution
and long-term availability still need their own qualification. In particular,
the Android-12-specific enrolled-network approval routine is not evidence that
the same accessibility routine can operate protected prompts on Android 16+.
The reviewed snapshot contains no top-level LICENSE file; establish the exact
reuse terms before copying components. This review adopted no code or APK.

## YepControl relationship

**Proposal recorded 2026-10-20; name adopted 2026-10-21:**
[YepControl](product.md#product-direction-yepcontrol) is the public
device-control brand, initially for this Android product.
Machine Control could supply shared Android primitives and later adopt the
brand on its desktop application while retaining compatible toolkit/CLI names.
No module extraction or sibling rebrand has been performed for this proposal.

YepAnywhere's experimental [Android host](../../yepanywhere/topics/android-host.md)
is a related product surface: it runs agents and owns their projects, sessions
and provider authentication on the phone. This app supplies human-directed
access, including a way to repair that authentication when an agent is unable
to proceed. Native capability reuse could serve both; a YA runtime or session
remains optional for manual access. Android host is distinct from YA's remote
companion and capture/control sidecar; see its
[package guide](../../yepanywhere/packages/android-host/README.md).

Potential shared work includes wake/keyguard state, accessibility input and
guarded PIN unlock, retaining the differences between ADB and app-resident
providers. Each consuming app keeps its own authorization and secret custody;
APK packaging and any direct product integration remain open. The
[product direction](product.md#product-direction-yepcontrol) owns the proposal;
the source-review records below retain their original pins and evidence limits.

## Buddy Android: primary phone-resident reference

[Buddy Android](https://github.com/ghorbelhamdi/buddy-android/tree/ffd2ec84c7498c9e10e22889b4f4d1f52c293e18)
is an external reference checked out under YA's ignored `references/` directory,
not a direct sibling or a required runtime dependency. Its native accessibility
screenshots, gestures and focused-field editing, with a local API boundary, are
especially relevant to this standalone manual-access spike. See the pinned
[YA source review](../../yepanywhere/docs/competitive/buddy.md) and
[spike provenance](spike.md#source-references).

The app declares Apache-2.0; bundled assets/native components have separate
terms. We reviewed the native control and API code without importing Buddy code,
binaries, art, Alpine/PRoot, provider CLIs or its agent loop. The current spike is
an independent implementation of Android SDK primitives. This review does not
establish Buddy's unattended, secure-unlock or reboot behavior.

## Machine Control entry points

- [Android platform guide](../../machine-control/platforms/android/README.md):
  exact-device ADB readiness, wake/dismiss, known-PIN path and prerequisites.
- [Android family topic](../../machine-control/topics/android-family-control.md):
  platform boundaries, native operations and remaining acceptance gaps.
- [Platform/API research](../../machine-control/research/platforms/android.md):
  ADB versus app-resident authority and phone-local experiments.
- [Resident spike](../../machine-control/platforms/android/resident-spike/README.md):
  a native AccessibilityService, a bounded grant, fixture-scoped semantic control
  and inline screenshots. Real local Codex/Claude runs were accepted there;
  remote/background/reboot/general-app control was not.
- [Protected unlock work](../../machine-control/docs/tactical/016-device-readiness-and-android-unlock.md):
  one-shot PIN delivery over private stdin, readiness/credential/wipe-policy
  checks and independent effect observation. Correct-PIN physical acceptance
  remains explicitly open in the reviewed record. Do not claim it already
  solves consumer unlock.

MC's existing unlock controller builds a helper using a JDK/Android SDK. That
is not proof the same route can run phone-locally in an ordinary APK. A product
would need deliberate helper packaging or another audited native integration.

## Yep Anywhere entry points

- [Android-host contract](../../yepanywhere/topics/android-host.md) and
  [host package](../../yepanywhere/packages/android-host/README.md): user-started
  foreground service, native state, sign-in shortcuts and explicit lifecycle
  limitations. The host runs provider CLIs in Alpine/PRoot. This standalone app
  has no established need for Alpine, Node or an agent runtime.
- [Manual stream client](../../yepanywhere/packages/client/src/pages/EmulatorPage.tsx),
  [input/video component](../../yepanywhere/packages/client/src/components/EmulatorStream.tsx)
  and [device bridge](../../yepanywhere/packages/device-bridge/): Android hardware
  capture and a WebRTC/manual-input path, independent of AI inference.
- [Existing streaming design](../../yepanywhere/docs/project/android-emulator-remote-control.md):
  signaling uses YA transport; video is direct WebRTC with STUN and no TURN
  fallback in the reviewed source. That is a networking limitation to resolve,
  not a complete consumer remote-access architecture.
- [Push contract](../../yepanywhere/topics/android-fcm-push.md): credential-free
  generic notification delivery, revocable subscriptions and native lifecycle
  tests. It is not acceptance of remote phone wake or secure unlock.
- [Buddy research](../../yepanywhere/docs/competitive/buddy.md),
  [Shizuku research](../../yepanywhere/docs/competitive/shizuku.md) and
  [Termux research](../../yepanywhere/docs/competitive/termux.md): pinned upstream
  studies with policy/provenance boundaries. Consult original sources before
  adopting components; Buddy's AI harness is not needed for manual access.

## Yep Anywhere FCM implementation reference

Source-reviewed **2026-10-20** at committed baseline
`92eb659827c98dedf257b5ff08a5a5b3d8bda73d`; the sibling working tree was clean.
No sibling changes, builds, push sends or device tests were performed here.
This is the reference to consult when implementing our own FCM registration,
hosted sender and lifecycle checks, rather than starting from an empty example.

| Reference | Useful mechanism and boundary |
| --- | --- |
| [FCM contract](../../yepanywhere/topics/android-fcm-push.md) | Registration lifecycle, native installation capabilities, delivery privacy, Firebase configuration and bounded recovery. Owns the current design. |
| [Messaging service](../../yepanywhere/packages/android/app/src/main/java/com/yepanywhere/mobile/notifications/YepFirebaseMessagingService.kt) | Native `FirebaseMessagingService`; `onRegistered` updates the installation target; receipt is independent of an Activity/WebView. `onNewToken` is the legacy callback in this pin. |
| [Installation coordinator](../../yepanywhere/packages/android/app/src/main/java/com/yepanywhere/mobile/notifications/BrokerInstallationCoordinator.kt) and [storage](../../yepanywhere/packages/android/app/src/main/java/com/yepanywhere/mobile/notifications/BrokerInstallationStore.kt) | Stable broker installation with current-target digest, replacement on change, one fresh registration after broker NOT_FOUND, and deferred failure. Delivery registration is separate from product pairing. |
| [Native broker client](../../yepanywhere/packages/android/app/src/main/java/com/yepanywhere/mobile/notifications/PushBrokerClient.kt) | Bounded native installation/subscription API boundary; installation management belongs on the phone rather than in hosted page state. |
| [Firebase provider](../../yepanywhere/packages/push-broker/src/providers/firebase.ts), [validation](../../yepanywhere/packages/push-broker/src/validation.ts) and [rate limiting](../../yepanywhere/packages/push-broker/src/rate-limiter.ts) | TypeScript Firebase Admin sender, data payload construction, provider error classification, validated delivery targets and broker admission controls. |
| [Coordinator tests](../../yepanywhere/packages/android/app/src/test/java/com/yepanywhere/mobile/notifications/BrokerInstallationCoordinatorTest.kt), [provider tests](../../yepanywhere/packages/push-broker/test/firebase-provider.test.ts) and [broker integration tests](../../yepanywhere/packages/push-broker/test/e2e/broker.e2e.test.ts) | Entry points for registration/target replacement, delivery outcome and API-boundary regression coverage. Tests were located, not run in this review. |
| [Headless instrumentation](../../yepanywhere/packages/android/app/src/androidTest/java/com/yepanywhere/mobile/notifications/NativePushHeadlessInstrumentedTest.kt), [live instrumentation](../../yepanywhere/packages/android/app/src/androidTest/java/com/yepanywhere/mobile/notifications/NativePushLiveInstrumentedTest.kt) and [physical lifecycle record](../../yepanywhere/docs/testing/android-lifecycle-hardening-2026-10-07.md) | Useful harness/evidence for notification handling without UI and after process death. Preserve the original record's device/runtime limits; it is not new acceptance for this product. |

At this pin YA documents Firebase Messaging **25.1.1**, BoM **34.16.0**, FID
targeting and `onRegistered`. Verify the supported SDK/API when adding our
dependencies rather than assuming every example using `onNewToken` matches it.
The [original smoke](../../yepanywhere/docs/tactical/069-android-fcm-live-smoke.md)
is historical: its initial diagnostic logging/config instructions were
superseded by the [native foundation](../../yepanywhere/docs/tactical/071-android-wrapper-notification-integration.md)
and current topic contract.

Adapt the lifecycle and tests, not YA's product identity. We need product-specific
Firebase app configuration and hosted sender authorization; do not copy
its registrations, credentials, server subscriptions or deployment targets.
Whether a separate broker is useful is still an implementation choice; the
reference does not require that extra service for our single hosted relay.

YA sends notifications and opens authenticated session destinations. Our FCM
message is a best-effort wake hint followed by authenticated pending-request
lookup and session establishment. Its high-priority sender is not blanket
permission for silent wake traffic: validate our user-visible semantics and
FCM processing window. This source review does not prove display wake, phone
unlock, access before first unlock, force-stop recovery or an overnight
socket-free control session. Keep our paired-device/session authority independent
of delivery registration and preserve the stated [platform limits](android-platform.md).

## Babytrack and JSTorrent encryption references

Source-reviewed **2026-10-20**, read-only, with clean sibling working trees:

| Reference | Committed baseline | Mechanism and relevance |
| --- | --- | --- |
| [Babytrack encryption topic](../../babytrack/docs/topics/sync-and-encryption.md), [sharing protocol](../../babytrack/docs/protocol/sharing-v1.md), [wire crypto](../../babytrack/wire/src/crypto.rs) and [HPKE](../../babytrack/core/src/hpke.rs) | `4118bb98d802eb0e200c174e9f799b477bed5ab1` | Encrypted durable records: XChaCha20-Poly1305 epoch keys, Ed25519 signatures and RFC 9180 HPKE (X25519/HKDF-SHA256/ChaCha20-Poly1305) grants to authorized devices. Shared Rust/native-Wasm crypto and known-answer vectors. Useful for relay blindness, key ownership and device removal; its group epochs/history machinery is not needed for our live phone sessions. |
| [JSTorrent authentication topic](../../jstorrent/docs/topics/remote-access-authentication.md), [session/resume construction](../../jstorrent/docs/tactical/192-production-owner-relay-access.md), [resume source](../../jstorrent/crates/rstorrent-remote-crypto/src/resume.rs) and [record source](../../jstorrent/crates/rstorrent-remote-crypto/src/record.rs) | `fe4be51c235767db87e05a2dcba70747c14687f4` | Closer live-session reference: OPAQUE passphrase bootstrap, then remembered-browser P-256 signing identities and transcript-bound fresh ephemeral P-256 ECDH on resume. HKDF-SHA512 derives directional ChaCha20-Poly1305 records with authenticated headers and sequences. One Rust core runs natively and via Wasm; the opaque relay has no application decryption keys. Our QR bootstrap can replace the passphrase UX, but that is a new protocol composition requiring its own review. |

These are source mechanisms, not a new cryptographic audit or physical test.
Neither requires an account just to obtain E2E protection. Neither makes the
Android lock PIN an encryption secret. Both document the hosted-web boundary:
a compromised site can serve JavaScript that accesses plaintext at the endpoint.
Relay privacy and independently trusted client distribution are distinct claims.

For this product, prefer JSTorrent's separation of paired identities, fresh
session keys, application records and opaque routing. Keep endpoint public-key
pins and authorization on the phone/browser, not solely in the relay database.
The current spike's relay-authenticated pairing is not yet an E2E channel, and
the browser must gain durable phone-key pinning before production sessions.
Consult Babytrack for key lifecycle and vectors without adding shared-history
keys to a live remote-control protocol. Copying the siblings' shared crypto
implementation would introduce Rust/native-Wasm bindings; using platform
cryptography in our TS/Kotlin stack instead requires the same exact wire spec,
cross-language vectors and handshake review. Neither implementation choice is
selected by this source comparison.

## Licensing and ownership

MC and JSTorrent declare MIT in their repository documentation; examine exact
files and bundled component notices before copying. Review YA's current license
and every extracted component rather than inferring rights from common ownership.
RustDesk, droidVNC-NG, scrcpy and Shizuku have different upstream licenses; see
the competitor analysis. No upstream code, APK, artwork, credentials, device
inventory or generated state has been copied into this repository.

Use the common MC CLI and platform guides for future machine tests, with private
target selection kept outside Git. Read each sibling's AGENTS.md/local rules
before any edits or device work. Shared Git history is not authorization to
rewrite an unrelated working tree.
