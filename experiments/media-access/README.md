# Camera and microphone feasibility probe

Owner-requested experiment, 2026-10-31. This is a separate test application,
`com.yepcontrol.mediaspike`, not a feature in the released YepControl host.
See [findings and shipping considerations](../../docs/camera-microphone-spike.md).

The probe uses Camera2 JPEG frames and AudioRecord PCM16LE mono at 16 kHz.
A loopback-only Node WebSocket bridge forwards media to bundled, headless
Playwright Chromium. The browser decodes JPEGs onto a canvas and measures PCM
samples; it does not play audio aloud or save camera/audio recordings. Media
queues are bounded and frames are dropped under backpressure. This establishes
sensor access and browser delivery, not production quality or Internet transport.

The phone connects through an explicitly selected ADB reverse tunnel. A fresh
random token authenticates the phone and browser to the local bridge. Cleartext
WebSockets are allowed **only in this separate experiment APK**; this is not the
product's pairing or end-to-end encryption protocol. Do not expose this bridge
to the Internet or use its protocol in the released app.

## Run

Requires the repository toolchain, installed Playwright Chromium, and the
public Android handheld adapter from a sibling `machine-control` checkout.
`ANDROID_DEVICE_CLI` may point to another checkout's `android-device` executable.
Use a locally unlocked, authorized test phone. The runner verifies the exact
device/model and primary user, and refuses to replace an existing experiment
package. It never replaces the Play-installed host.

```sh
./android/gradlew -p android -PmediaSpike=true :media-spike:assembleDebug
MEDIA_DEVICE=YOUR_SERIAL MEDIA_DEVICE_MODEL='YOUR MODEL' \
  node experiments/media-access/run.mjs
```

The runner accepts normal camera, microphone and notification prompts through
observed UI buttons. No `pm grant`, app-op override, battery exemption,
instrumentation of the app under test, lock credential or debugging change is
used. It waits 20 seconds after Home before background-start attempts to avoid
the recent-visible-activity grace period.

An optional second run with `MEDIA_ACCESSIBILITY=1` enables **only this
experiment's** accessibility service through Android Settings. The service has
no screen-reading or gesture capabilities; it tests the effect of the system
binding that the real host already has. Existing accessibility services remain
enabled. Uninstalling the experiment removes its service and permissions.
This does not qualify the product's actual process/session lifecycle.
The runner verifies that the service is actually bound. If direct background
startup is refused, it also tests asking that service to show the probe's
visible activity, then starting the foreground service from that activity.
See the findings for device-specific acceptance and remaining platform limits.

The default run ends with screen-off capture. It wakes the display afterward
without entering credentials; a securely locked phone may remain locked.
Use `MEDIA_SCREEN_OFF=0` to omit that case when keeping the phone unlocked is
needed for another test. The prior activity is restored only when unlocked.

The enabled test session expires after two minutes, does not restart its service
automatically, and stops on transport failure. There is a visible foreground
notification with Stop and a Stop button in the app. On normal completion or
failure the runner closes Chromium, removes its own ADB tunnel, stops/uninstalls
its package, and stores counts and events in a model subdirectory under ignored
`.local/media-access/`. `MEDIA_TEARDOWN=disconnect` closes the socket during active
capture and checks that the service and sensor access end, instead of sending
the usual remote Stop commands.
`MEDIA_FOCUS=cold-screen-off` limits the run to a fresh media-service start
after Home, a 20-second wait, and screen sleep. It checks display state before
startup and after capture, then stops and removes the probe. This is a fresh
media service, not a reclaimed-process/FCM test. A successful focused start also
checks remote sensor off/on; combine it with `MEDIA_TEARDOWN=disconnect` to
end that run through socket closure. Noninteractive sleep may be reported as
`Asleep` or `Dozing` (ambient display); the runner records the exact state and
does not change the phone's ambient-display settings.
That directory can contain private diagnostics; do not commit it. A controller
crash requires manual removal of its test package/tunnel.

## Checks

```sh
./android/gradlew -p android -PmediaSpike=true \
  :media-spike:assembleDebug :media-spike:ktlintCheck :media-spike:lint
pnpm exec biome check experiments/media-access/run.mjs
git diff --check
```

The Gradle module is included only with `-PmediaSpike=true`; normal product
builds and release workflows do not include its manifest, dependencies or APK.
