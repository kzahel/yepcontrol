# Phone-local ADB experiment

An independently installed Android 11+ experiment (`com.yepcontrol.adbspike`),
authorized 2026-11-01. No released app, relay, browser protocol or pairing is
modified. The module is excluded from normal builds. No APK is published.

The question is whether optional advanced control can be set up and restored
entirely on the phone, without a computer, root, PRoot, an ADB executable/server
or a separate Shizuku installation. Android's system `adbd` remains necessary.
Developer options and Wireless debugging remain explicit user setup steps.

## Measured result — 2026-11-01

**The complete default-debug acceptance run passed** on an owned Android-16 /
API-36 Google APIs arm64 emulator. The computer supplied the development/test
harness, not the pairing or privileged bootstrap commands. This is an isolated
feasibility result, not an integrated YepControl feature or physical acceptance.

| Check | Observed result |
| --- | --- |
| Default off | No advanced service, pairing identity or settings grant on fresh launch. |
| Phone-local manual setup | Native Settings pairing code delivered on-device; app performs pairing and starts a helper. `WRITE_SECURE_SETTINGS` remains ungranted. |
| Helper identity | Android Binder reports UID 2000. The ordinary app cannot attest as shell, even with the correct bootstrap secret. |
| Separate restoration opt-in | Enabling the checkbox later makes the existing phone-local ADB client self-grant the settings permission, without replacing the live helper. No desktop `pm grant` or `adb pair`. |
| Protected input | Ordinary accessibility gesture reports `completed`, with native target count unchanged. Helper sees five nodes, two sensitive, and one clickable; its tap increments the independent target counter. |
| Three automatic reboot recoveries | **27.95, 27.59, 27.79 seconds** from reboot request to a fresh Ready receipt. Same saved identity and settings grant; no app launch or desktop enable/grant during recovery. |
| Wi-Fi disabled | The same helper still delivers protected input after the ADB listener disappears. |
| Wi-Fi plus helper loss | Authenticated helper stop while Wi-Fi is off, then Wi-Fi restoration: app restores its listener and starts a new attested helper automatically. |
| ADB listener disabled plus helper loss | App requests listener restoration and starts a fresh helper through its own saved pairing. |
| App force-stop | Orphan helper exits after **29.86 seconds**. Explicit normal app launch restores advanced control. This is not a claim of recovery while Android keeps an app force-stopped. |
| Advanced off, then reboot | No advanced service returns; the off readiness receipt is unchanged. The boot guard starts no worker/helper or settings writes. |

The emulator had no secure PIN. Recovery was measured after ordinary Android
boot/unlocked storage became available; it does **not** establish first secure
unlock, direct-boot control, a manual notification-shade walkthrough, Android-17
or OEM behavior, Doze, overnight availability or Play acceptance. Physical phone
debugging/lock settings and reboots were outside this experiment's authorization.

The outage test exposed a real race: Android can reject `adb_wifi_enabled=1`
while Wi-Fi is still associating. The corrected implementation waits for stable
Wi-Fi availability and makes at most three enable attempts before requiring
phone-side repair. It does not approve new-network trust dialogs automatically.

The arm64 size-only shrunk APK is **4,744,855 bytes**, versus **22,676 bytes** for
the empty shrunk baseline. This includes the UI and test-fixture components;
it is not an incremental production AAB download estimate. Conscrypt's native
library accounts for about 2.1 MB, and unused Bouncy Castle resource files remain
packaged. Shrunk execution is not qualified (see the harness limitation below).

In the full passing debug run, process PSS was **43,038 KiB for the app** and
**79,709 KiB for the helper**. An earlier run measured 37,357 / 46,309 KiB at the
same checkpoint. These are snapshots with substantial ART/framework costs, not
a baseline delta, a steady-memory guarantee or a power measurement. The native
route avoids a Linux environment, but its resident helper is not memory-free.

**Recommendation:** proceed to bounded physical qualification, then an explicitly
opted-in Advanced screen. Preserve ordinary accessibility control as the default.
For production, investigate leasing the privileged helper to actual advanced
sessions rather than keeping its ART process resident indefinitely. Qualify the
resulting startup latency, long-idle authorization maintenance, owner-user/OEM
recovery, dependency/licensing choice and production key storage before shipping.
Existing YepControl browser grants, input switches and encrypted sessions must
gate this stronger provider; this experiment has no browser/relay integration.

Private complete-run receipts, logs, APK hashes and memory reports remain under
ignored `.local/local-adb-acceptance/` and `.local/local-adb-spike/size/`. The runner
reaped its owned emulator after acceptance. No product APK or release was changed.

Current implementation limits include owner-user testing only, helper-side
Android framework reflection for the shell context/input/UiAutomation, and no
physical OEM or Play-installed qualification. The ordinary app does not request
a hidden-API exemption. The helper runs with explicitly obtained shell authority.
Its startup attestation follows Android's own
[`content` command's external-provider route](https://android.googlesource.com/platform/frameworks/base/+/99b01a65cc4c104933788b3143285ab6bae65827/cmds/content/src/com/android/commands/content/Content.java),
which supports a shell process without an ActivityManager-registered Application.

## Build and run

Use the repository's JDK 17 and Android SDK prerequisites. Install the SDK's
API-36 Google APIs emulator image matching the host architecture. Example for
Apple Silicon:

```sh
cd android
./gradlew -PlocalAdbSpike=true :local-adb-spike:assembleDebug \
  :local-adb-spike:assembleDebugAndroidTest :local-adb-spike:lintDebug
cd ..
python3 experiments/local-adb/accept.py
```

For x86 hosts add `-PlocalAdbAbi=x86_64`. The runner creates, wipes and owns its
own emulator, refuses an occupied selector, validates both APK package IDs,
and reaps only its emulator in `finally`. It cannot select a physical phone.
Private output is under ignored `.local/local-adb-acceptance/`. Do not commit
its keys, emulator data, logs or raw receipts. A fresh run repeats native setup.

The desktop installs the two APKs, starts phone-side UI tests, observes private
receipts and induces outages/reboots **on its owned emulator**. It never runs
`adb pair` or grants `WRITE_SECURE_SETTINGS`. The native test reads the pairing
code on-device and submits the app notification's RemoteInput PendingIntent
while the Settings dialog remains open. This exercises notification reply
delivery, not a manually operated notification-shade walkthrough. The code
does not leave the device. Accessibility comparison consent uses native UI.

For size-only comparison, `-PlocalAdbBaseline=true` builds an empty activity with
the same toolchain, and `-PlocalAdbMinify=true` enables shrinking. Build only
`:local-adb-spike:assembleDebug` for that measurement. Shrunk APK execution is
not qualified here: AndroidX instrumentation loses shared Kotlin runtime classes
when paired with the shrunk target. Rebuild **both default debug APKs** before
running acceptance. APK bytes are not a Play download-size or battery result.

Lifecycle probes are debug-only activities protected by Android's signature
`DUMP` permission. They avoid instrumentation's force-stop of the target app
during recovery measurements. Reboot readiness is observed before launching
any activity; wake/dismissal afterward only prepares the synthetic tap fixture.

## Mechanism

1. Advanced control and automatic restoration both default off. Ordinary app
   launch does not create an ADB identity, worker or helper.
2. The owner enables advanced setup and, separately, automatic restoration.
   Android Settings supplies the Wireless debugging pairing dialog.
3. A native Java ADB client discovers only listeners belonging to local network
   interfaces and connects through `127.0.0.1`. SPAKE2/TLS pairing uses the code;
   the identity stays in app-private, backup-excluded storage.
4. Through that paired connection, the app verifies UID 2000, optionally grants
   **itself** `WRITE_SECURE_SETTINGS`, and starts a small shell-UID Java helper
   using Android's existing `app_process`. The ADB connection is then closed.
5. The helper exposes only ping, tap, a count-only sensitivity snapshot and stop.
   It binds loopback and mutually authenticates each request/response with HMAC
   and fresh challenges. An app ContentProvider independently checks Android's
   Binder caller UID/PID, accepting startup attestation only from UID 2000 with
   the current bootstrap secret/port. Responses must match that attested PID;
   a local server cannot establish readiness by claiming to be shell. The
   bootstrap secret travels inside the paired stream into a mode-0600 temporary
   file, then is read/deleted by the helper; the app also attempts cleanup after launch failures.
   No secret is placed in process arguments or public diagnostics.
6. Shell input uses `InputManager` injection. A sensitivity snapshot briefly
   acquires UiAutomation with `DONT_SUPPRESS_ACCESSIBILITY_SERVICES`, counts
   nodes, then disconnects. It returns no screen text. The fixture uses a native
   `accessibilityDataSensitive=YES` view, independently counting received taps.
7. An enabled foreground service maintains the helper's 30-second lease. After
   normal `BOOT_COMPLETED`, it waits for Wi-Fi and, if expressly opted in and
   granted, requests `adb_wifi_enabled=1`, rediscovers the listener, reconnects
   using its saved identity and starts a fresh helper. There is no root daemon
   or direct-boot component. A secure phone's first local unlock is still needed.
8. Turning the experiment off stops its service/helper. Its boot receiver returns
   after the opt-in check, starting no worker/helper or settings writes.
   It leaves Android's existing debugging setting and the separately granted
   permission alone. Forgetting/revocation UX is not implemented in this spike.

This is feasibility code: synchronous bounded listener discovery, a five-second
lease heartbeat and a foreground notification, not a battery-qualified product
implementation. A failed input request is not replayed. Snapshot authority is
broader than ordinary accessibility and must remain behind the same explicit
advanced grant if integrated into YepControl.

Long-idle authorization is a separate follow-up. Reviewed Android-16 source
at `99b01a65cc4c104933788b3143285ab6bae65827` expires inactive remembered ADB keys
through [`AdbKeyStore.isKeyAuthorized`/key filtering](https://android.googlesource.com/platform/frameworks/base/+/99b01a65cc4c104933788b3143285ab6bae65827/services/core/java/com/android/server/adb/AdbDebuggingManager.java),
with a [seven-day platform default](https://android.googlesource.com/platform/frameworks/base/+/99b01a65cc4c104933788b3143285ab6bae65827/core/java/android/provider/Settings.java).
Helper heartbeat traffic does not refresh that ADB connection timestamp.
A production design needs bounded reconnection/authorization maintenance and
an explicit re-pair state; this experiment does not change Android's timeout
setting or claim qualification beyond the short reboot/outage runs.

## Dependencies and distribution boundary

Exact components reviewed 2026-11-01:

| Component | Pin | License/source finding |
| --- | --- | --- |
| [libadb-android](https://github.com/MuntashirAkon/libadb-android/tree/c849886ebc6d48e7b46d967e78a6bb65c90c3b74) | 3.1.1, `c849886…` | Top-level GPL-3.0-or-later **or** Apache-2.0; choose Apache branch. Repository also carries component MIT/BSD notices. |
| [spake2-java Android](https://github.com/MuntashirAkon/spake2-java/tree/7615ddd680b990e14513ebb66eac4cb0dbf82464) | 2.2.1, `7615ddd…` | LGPL-3.0; includes native pairing code. Upstream labels its crypto unaudited. This dependency is **not approved for product shipping** by this spike. |
| [spake2-c native submodule](https://github.com/MuntashirAkon/spake2-c/tree/0d15933e5ba3e662cb01245a7ac0dc9fca3eac31) | `0d15933…`, pinned by spake2-java | Top-level LGPL-3.0; reviewed `spake2.c` carries an ISC-style notice and `sha512.c` derives from glibc under LGPL-2.1-or-later. Preserve component notices; do not infer permissive licensing from the pairing algorithm alone. |
| [Conscrypt](https://github.com/google/conscrypt/tree/2.5.3) | conscrypt-android 2.5.3 | Apache-2.0 plus bundled native third-party notices; provides a public TLS exporter, avoiding app hidden-API bypass. |
| [Bouncy Castle](https://github.com/bcgit/bc-java/tree/r1rv81) | bcprov-jdk15to18 1.81 | Bouncy Castle license; used for the identity certificate. |

Only Maven/JitPack dependencies are used; no sibling or Shizuku source was
copied. Native/component notices and LGPL compliance, crypto review and release
packaging are explicit production follow-ups. The experiment's RSA identity is
stored as private PKCS#8 in the no-backup sandbox, not an approved production
key-vault design. Losing app data loses this pairing identity. Android's TLS ADB
protocol uses remembered client authorization; the client library's permissive
TLS trust manager is not a remote-server identity guarantee. Loopback-only
connection selection, OS-verified helper attestation and its separate mutual
authentication matter. This is not a claim of a completed security audit.

See [the investigation](../../docs/sensitive-screen-input.md) for the physical
Maps evidence and why ordinary accessibility cannot reliably label a blocked
tap. Emulator success must not be reported as Android-17/OEM or Play acceptance.
