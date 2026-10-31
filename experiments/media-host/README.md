# Production sensor acceptance fixture

This opt-in debug build compiles the production `media/` controller/services into
`com.yepcontrol.app.mediafixture`. It preserves the installed Play package and its
pairings. Its activity, loopback WebSocket bridge and extra label/resources exist
only with `-PmediaFixture=true`, and never enter a release source set. The fixture
has no FCM enrollment; production encrypted control is qualified separately.

Build with the repository's pinned toolchain:

```sh
cd android
./gradlew -PmediaFixture=true ktlintCheck :protocol:test :app:lint :app:assembleDebug
```

Then, from the repository root (with Node from `.node-version`), select one
owner-authorized, already-unlocked phone explicitly:

```sh
MEDIA_DEVICE=EXPLICIT_SERIAL MEDIA_DEVICE_MODEL='EXACT_MODEL' \
MEDIA_FIRST_SENSOR=camera MEDIA_SCREEN_OFF=1 node experiments/media-host/run.mjs
```

`MEDIA_HOST_APK` optionally selects a saved fixture APK. The runner checks the APK
application ID and compiled fixture class **before installation**, refuses an
existing fixture installation, and uses a fresh bearer token and selected ADB
reverse tunnel. It grants permissions through ordinary Android UI, exercises the
production optional settings/disclosures, and verifies actual accessibility
binding. Use camera first on one phone and microphone first on another to prove
each sensor works before the other's permission exists.

The noninstrumented bridge calls the production capture controller; a bundled
headless Playwright Chromium independently decodes JPEG/H.264 and measures PCM.
It stores counts and lifecycle metadata, not raw images/audio. Receipts and any
UI diagnostics go into ignored owner-only `.local/media-access/implementation/`.
It delivers the exact Stop action PendingIntent retrieved from the production
notifications while both sensors run in the background (creator package/action
checked), then checks feature/owner revocation, canceled camera startup, lease
expiry, background/screen-off restart, socket teardown, foreground-service removal
and OS app-ops. This sensor fixture does not qualify product E2E encryption,
FCM/process recovery, browser audio playback, reboot, device-idle Doze or overnight
survival. Screen-off is observed as Asleep or ambient Dozing, not inferred to be
Doze. The fixture's outer deadline is ten minutes; renewable media leases remain
20 seconds with a ten-second startup deadline.

Cleanup removes only the owned fixture and its tunnel, closes its test browser,
and compares the previous accessibility-service set. A secure phone can remain
locked after screen-off tests: restore it with the guarded configured Machine
Control procedure in the [implementation plan](../../docs/camera-microphone-plan.md).
The runner never reads credentials or changes lock/debugging settings.

Platform references reviewed 2026-10-31:

- [Foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)
  requires each sensor's type and granted runtime permission. Separate services
  avoid inheriting an inactive sensor's permission requirement.
- [Background restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
  distinguishes launch eligibility from runtime permission. A bound accessibility
  service's measured behavior remains device-specific evidence.
- [Audio silencing](https://developer.android.com/reference/android/media/AudioRecordingConfiguration#isClientSilenced())
  identifies framework-silenced recordings. The microphone also stops on global
  mute. Silence in a genuinely quiet room is not itself an error.
- [SensorPrivacyManager](https://developer.android.com/reference/android/hardware/SensorPrivacyManager)
  exposes toggle support, without a public current-camera-toggle getter. We do
  not use hidden APIs or infer camera privacy state from black pixels. Permission
  readiness reports the actual runtime grant; Android may supply blank camera
  frames under privacy controls. Camera disabled/error callbacks terminate capture.
- [Feature declarations](https://developer.android.com/guide/topics/manifest/uses-feature-element)
  explains permission-implied filtering. Camera, autofocus, flash and microphone
  remain explicitly optional; ordinary phone control does not require sensors.

Native camera frames are normalized to upright pixels at stream start, without
GPS/EXIF location metadata. Strided/interleaved YUV rotation has pure JVM tests.
A display-rotation change stops that camera stream; the controller must explicitly
start again with fresh dimensions. PCM is mono signed 16-bit little-endian at
16 kHz. No additional codec or camera library is copied into the product.

Additional Phase 2 interruption qualification:

```sh
pnpm test:mobile-smoke --media
# A targeted rerun after an instrumentation-test-only change:
pnpm test:mobile-smoke --media --media-only
# On an explicitly selected phone, fresh fixture install and ordinary Settings UI:
MEDIA_DEVICE=EXPLICIT_SERIAL MEDIA_DEVICE_MODEL='EXACT_MODEL' \
MEDIA_FOCUS=permission-loss node experiments/media-host/run.mjs
```

The owned-emulator `--media` suite adds two real permission-dialog recreation
checks, separate-UID camera contention, global microphone mute and framework
silencing by a privacy-sensitive competing recorder. It checks affected-sensor
termination, native app-ops/service release, continued frames from the unaffected
sensor and no automatic restart. Instrumentation lends startup privileges, so
these tests do not replace the noninstrumented background eligibility evidence.
The independent contender is Java code only in the instrumentation APK; it
retains no audio or images. The camera-open ownership helper has deterministic
JVM callback-order tests, including release before a late open and waiting for
native onClosed before completion.

`permission-loss` revokes only the fixture's camera grant through Android
Settings during combined capture. Android terminates that app process, ending
both sensors. The runner independently checks socket loss and OS resource release,
then reconnects without starting sensors, observes the retained feature setting
and missing camera permission, and explicitly tests microphone-only recovery.
Its receipt is `result-permission-loss.json`; it does not replace the full run.
The mobile runner snapshots and validates its APK inputs before emulator boot,
so building the separate fixture cannot change the installed test binary.
