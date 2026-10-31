# Remote camera and microphone investigation

Requested and reviewed 2026-10-31. The owner authorized a bounded spike on an
attached phone to assess adding optional camera and microphone access to
YepControl. This is not a production implementation, release submission or
permission to change physical-phone credentials, lock settings or debugging.
The subsequent [implementation plan](camera-microphone-plan.md) records the
proposed six phases, required independent reviews and guarded unlock procedure.

## What setup permission does and does not buy

Camera (`CAMERA`) and ambient microphone (`RECORD_AUDIO`) are normal runtime
permission requests. Separate optional setup controls can explain each and
request Android's approval. Unlike MediaProjection screen sharing, they do not
need a new projection-consent token per capture session. They are nevertheless
**while-in-use** permissions, not unconditional permission to activate sensors
from any background state.

An app running a camera/microphone foreground service must declare the matching
service types and permissions. An ordinary background app cannot simply start
one after receiving a network command. Android 14+ can reject startup immediately;
older Android versions can allow a service while still refusing sensor access.
Starting an eligible service while the app is visible is a supported path for
continuing access after leaving the activity. A push-wake exemption from the
general foreground-service start restriction is distinct from while-in-use
sensor eligibility.

Evidence: **platform documented**, checked 2026-10-31:

- [Foreground service types, camera and microphone](https://developer.android.com/develop/background-work/services/fgs/service-types)
- [Background startup and while-in-use exemptions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [Android 11 foreground-service camera/microphone restrictions](https://developer.android.com/about/versions/11/privacy/foreground-services)
- [Runtime permissions, one-time grants and privacy indicators](https://developer.android.com/training/permissions/requesting)

The real host has an Android-bound accessibility service. Its effect needs
testing on each relevant lifecycle/platform: results from a plain background UID
are not proof that the existing host has the same eligibility. AOSP's while-in-use checks consider
particular binding/background-activity privileges, and instrumentation can
also change the result. Neither is a reason to request unrelated permissions
as a keepalive mechanism.

Evidence: **source reviewed**, not an API guarantee for every OEM or release:
[Android 16 ActiveServices at 99b01a65](https://android.googlesource.com/platform/frameworks/base/+/99b01a65cc4c104933788b3143285ab6bae65827/services/core/java/com/android/server/am/ActiveServices.java),
`shouldAllowFgsWhileInUsePermissionLocked`, including the background-activity
binding and instrumentation checks. Physical results below remain the
implementation evidence for the tested Android 17 phone.

## Experiment boundary

The [probe and runner](../experiments/media-access/README.md) install a separate
package, preserving the released host and pairings. The selected Pixel 7a runs
Android 17/API 37; the probe targets API 36, matching the released host. The
owner's follow-up selected the attached Moto g power (2022), Android 12/API 31,
which has no configured screen lock, for the remaining checks. No lock settings
are changed. Camera, microphone and (on API 33+) notification permissions
are accepted through normal Android UI. An optional comparison enables the
probe's minimal accessibility service through Settings and removes it with the
test package afterward, preserving other services.

Commands arrive through a real WebSocket, with no test instrumentation running
inside the probe. After Home the runner waits 20 seconds before background
startup. A separate bundled Chromium decodes live rear-camera JPEGs and checks
16 kHz mono PCM sample counts and energy. No raw camera/audio recording is
retained. The test has a visible notification/Stop action and a two-minute
deadline; it is not an overnight monitoring service.

The bridge uses loopback WebSockets over a selected ADB reverse tunnel with a
fresh test token. That isolates Android eligibility and browser decoding. It
does **not** qualify Internet/NAT traversal, product pairing/E2E security, native
WebRTC tracks, production codecs, playback/audio synchronization, FCM recovery,
Doze, process death, reboot or other OEMs. Screen-off samples, when present,
must be read alongside the observed wake/keyguard state, not assumed to prove
all of those conditions.

Private diagnostics are under `.local/media-access/`. Setup failures are not
counted as sensor results: the first probe incorrectly assumed a JPEG size at
or below 640 pixels wide, which this phone does not advertise. It now selects
the smallest supported JPEG size.

## Measured baseline

**Physically tested**, 2026-10-31, Pixel 7a/API 37, target SDK 36, optional
probe accessibility service disabled. Four-second browser measurement windows:

| State | Decoded camera frames | PCM samples | Result |
| --- | ---: | ---: | --- |
| Plain background app, permissions granted | — | — | Starting the service rejected with `ForegroundServiceStartNotAllowedException`. |
| Service started while activity visible | 67 | 63,360 | Rear camera 1920×1080 and non-silent audio received. |
| Sensors off, service retained, then Home and 20-second wait | 0 | 0 | No media while idle (one-second sample). |
| Later remote start while service remains enabled in background | 68 | 64,000 | Both sensors started without returning to the activity. |
| Remote off then another start, still in background | 66 | 64,000 | Capture resumed. |

All three active samples had zero browser JPEG/PCM handling errors and nonzero
microphone sample energy. Every off sample, after a 500 ms drain interval,
contained zero image/audio packets. Android app-op observations after teardown
showed neither sensor still running; no foreground service remained. The
experiment package and its tunnel were removed, and the previous activity was
restored. This run deliberately omitted screen-off to keep the phone unlocked
for the separate binding comparison.

These numbers demonstrate capture/transport/decoding, not audio playback
quality, speech intelligibility, calibrated frame rate or production bitrate.

### Initial Pixel follow-up limits

The attempted screen-off run reached Android's normal secure lock, then the
runner incorrectly treated the handheld diagnostic's nonzero **not ready for
interaction** exit status as a failed diagnostic. That interrupted measurement
before a screen-off media sample was collected. The phone was woken without
credentials, the test package/tunnel were removed, and an independent normalized
comparison confirmed the other enabled accessibility services were preserved.
At that stage, **screen-off camera/microphone capture was not qualified**. The runner now
accepts a valid locked-state diagnostic and continues cleanup independently if
another cleanup operation fails. Finishing this check on the Pixel requires
local unlock; the owner instead directed the remaining testing to the Moto.
No physical-phone credential had been delivered at that stage.

The preliminary accessibility comparison also did not establish a live binding:
the fixture force-stopped the probe between enabling accessibility and connecting.
Its repeated background refusal must not be generalized to the real bound
host. The revised runner preserves the binding and checks it explicitly. It
can additionally ask that bound service to bring a **visible** probe activity
forward, then start the camera/microphone foreground service from the activity.
This is a candidate remote-start route on an unlocked phone, not a secure-lock
bypass. Those revised Pixel cases initially remained pending; the later
owner-directed recovery below resumes them. Moto evidence is separate below.

### Owner-directed remote unlock and resumed Pixel testing

The owner's subsequent follow-up requested checking the existing saved-PIN
unlock routes and continuing on the Pixel. Machine Control's selected-target
inventory reported a ready, preconfigured PIN locator. The phone had ordinary
secure screen lock with credential-encrypted user storage already available;
**no reboot was performed during this investigation**. The earlier camera test
had only sent the normal screen-sleep event.

The first unlock preflights refused before reading or delivering a credential
because the initial notification/fingerprint surface did not expose a PIN
field. A side swipe away from the fingerprint target exposed credential entry.
The guarded Machine Control helper then delivered the configured PIN exactly
once and independently confirmed unlocked keyguard and available user storage,
with no retry or uncertainty. The agent did not read or print the PIN or change
credentials, lock settings or debugging. Test credentials and machine-specific
inventory remain outside this repository. The resumed camera tests use the same
separate probe package, preserving the installed YepControl host and pairings.

With the accessibility service confirmed bound, the resumed Pixel run started
a fresh media service directly from the awake background and delivered 66
1920×1080 camera frames and 63,680 non-silent PCM samples in four seconds, with
zero browser handling errors. The remote visible-activity route and subsequent
foreground/background off/on samples also passed. Camera and microphone data
continued after secure screen lock.

The full run then stopped at an overly narrow fixture assertion: the Pixel's
normal ambient display reports `Dozing`, while the Moto reports `Asleep`.
Neither is an interactive state; Android's
[PowerManager documentation](https://developer.android.com/reference/android/os/PowerManager#isInteractive())
explicitly describes the ambient-display distinction (reviewed 2026-10-31).
The runner now accepts either observed noninteractive power state, preserves
the exact raw value, and still rejects `Awake`. This is not a forced device-idle
Doze test. The incomplete run cleaned up its package/tunnel and preserved the
other accessibility services; a focused locked-state run verifies the remaining
fresh-start, off/on and disconnect cases together.

The **completed focused Pixel run** confirmed a live accessibility binding and
no existing media service, went Home, waited 20 seconds, then sent screen sleep.
Independent observations before startup reported `Dozing`, keyguard showing,
device locked, a secure PIN credential and available user storage. The remote
WebSocket request then started a fresh media service without an activity launch,
display wake or credential entry during capture:

| Pixel 7a/API 37 state | Decoded 1920×1080 frames | PCM samples | Browser errors |
| --- | ---: | ---: | ---: |
| Fresh media-service startup while securely locked/noninteractive | 66 | 63,360 | 0 |
| Remote Off → On, still securely locked/noninteractive | 66 | 63,680 | 0 |
| After socket disconnect (one second) | 0 | 0 | 0 |

Active samples were four seconds and had nonzero microphone energy. Power
remained `Dozing` after the initial capture. Off produced an empty sample;
disconnect removed the foreground service and Android app-ops showed neither
sensor running. Cleanup verified removal of the test package/tunnel and
preservation of the existing enabled accessibility services. The installed
YepControl host and pairings were preserved.

This establishes on-demand camera/microphone service startup, sensor restart
and disconnect cleanup while noninteractive on both tested Android generations,
including secure screen lock on the Pixel (the Moto has no secure keyguard). The application
process, control socket and accessibility binding were already alive. It does
not qualify FCM/process-loss recovery, first unlock after reboot, device-idle
Doze, overnight availability, the production media integration or Play approval.
Private Pixel evidence is under `.local/media-access/Pixel_7a/`.

After each new screen-lock event needed for setup or final restoration, the
same configured Machine Control helper was used for one guarded submission;
failed credential delivery was never retried. No credential value was printed
or manually read. No reboot, credential change, lock-setting change or debugging
change was performed.
The final Machine Control diagnostic independently confirmed the Pixel unlocked.

## Moto screen-off acceptance

**Physically tested**, 2026-10-31, Moto g power (2022), Android 12/API 31,
target SDK 36, optional accessibility service disabled. The runner adapts the
notification-permission check to the OS; API 31 has no notification runtime
permission prompt.

The plain background start was rejected with
`ForegroundServiceStartNotAllowedException`. Starting the media service while
the activity was visible allowed camera/microphone capture. Subsequent remote
starts and off/on cycles worked after Home and a 20-second wait. The rear
camera supplied 320×240 JPEG frames; active steady-state four-second samples
decoded 37–41 frames and 62,720–63,360 non-silent PCM samples, with zero browser
handling errors.

Android independently reported `mWakefulness=Asleep`, keyguard not showing,
device not locked, and no secure credential. Capture continued while asleep.
More importantly, **remote Off → On restarted both sensors while the display
stayed asleep**: the subsequent four-second window decoded 37 camera frames and
63,360 PCM samples. This qualifies screen-off use with an already enabled media
service on this phone, not secure-lock behavior on the Pixel. The first
screen-off window includes packets buffered during synchronous diagnostic calls
and is not used as a frame-rate measurement.

All off samples were empty after drain, and Android app-ops showed neither
sensor running after the service stopped. Cleanup verified removal of the test
package and tunnel, preservation of the existing enabled accessibility services,
and restoration of the prior activity. The phone remained unlocked. Private
evidence is under `.local/media-access/moto_g_power__2022_/`.

### Bound accessibility service and disconnect

A separate Moto run enabled only the probe's accessibility service through
normal Settings UI and independently reported
`armed=false; accessibilityBound=true` before testing. Unlike the preliminary
Pixel fixture, this run did not force-stop the app after enabling the service.

After Home and 20 seconds, a WebSocket request **started a fresh media foreground
service directly from the background**. No camera/microphone service had been
pre-enabled. Camera and microphone then delivered 36 JPEG frames and 62,720 PCM
samples in the four-second browser window. The alternative path—asking the
bound service to show the probe's visible activity, which starts the media
service—also worked, delivering 37 frames and 63,680 samples. There was no
controller-side ADB activity launch between the background request and either
of these samples.

Here, "fresh" refers to the media service: the application process,
accessibility binding and control WebSocket already existed. This does not
prove FCM/process-reclamation recovery, secure-lock behavior, or the same
eligibility on Android 17.

This run repeated the foreground, background off/on and screen-off off/on
cases successfully. Closing the WebSocket during active capture stopped
delivery, removed the foreground service, and left neither sensor running in
Android app-ops. The test package/tunnel were removed and existing accessibility
services were preserved. The supported conclusion is that the requested
on-demand design is technically plausible with the system binding already
needed by YepControl, on this Android 12 phone.

### Fresh media-service start while already asleep

A focused third completed run confirmed the accessibility service was bound
and the media service absent, went Home, waited 20 seconds, then put the display
to sleep. Android reported `Asleep`, no showing keyguard and no secure
credential **before** the WebSocket requested startup. The request started the
camera/microphone foreground service directly, then delivered 36 decoded
320×240 JPEG frames and 63,040 non-silent PCM samples in a four-second window,
with zero browser handling errors. A second power observation after capture
still reported `Asleep`. No activity launch, wake command or prior media
service was needed between sleep and capture.

Remote Off stopped both sensors, disarming removed the service, Android
app-ops showed no running sensor access, and all cleanup checks passed. This
confirms **on-demand remote startup while screen-off on the Moto**, without
retaining an idle camera/microphone service between uses. It still requires the
live accessibility binding, application process and control connection used in
this test. It does not qualify a killed process, FCM wake, Doze, reboot, a secure
keyguard or newer Android/OEM behavior.

One targeted-run setup attempt restored an old Settings detail page instead of
the accessibility list; it was not counted as a media result. The runner now
handles that observed Settings state and the subsequent focused run completed.
The Moto's test package/tunnel were removed, other enabled accessibility
services were preserved, and its display/prior activity were restored. The
Pixel was not touched during the Moto runs.

The opt-in APK builds and passes ktlint and Android lint (lint retains ordinary
experiment warnings about literal UI strings, matching the host's older target
SDK, and the pinned dependency). The runner passes Biome and Node syntax checks.
The normal Gradle project list still contains only `:app` and `:protocol`, and
the product manifest has no added camera/microphone service permissions. The
runner was exercised with the controller's Node 26.7.0; the product still pins
Node 24 LTS. No product release was built, deployed or published for this spike.

## Product direction to evaluate

The useful first feature is **live camera view and live listening**, separately
switched by an authenticated paired controller. Keep screen sharing independent.
Request sensor permissions only when enabling these optional features, with
clear disclosure about use while the app is not on screen. Denial should leave
screen control useful. Preserve global/per-controller revocation, local Stop,
visible sensor state and Android's privacy controls. Old released hosts must
remain usable and report the feature as unavailable.

The current product's WebRTC path is an encrypted **data channel**, not a native
audio/video track; its fallback carries application-encrypted H.264. Camera
video can potentially reuse the encoder/framing architecture, but source
selection, ownership, front/rear orientation and cleanup need implementation.
Audio needs capture, framing/codec choice, browser playback and bounded latency.
Native WebRTC tracks would be a separate media/E2E design, not a switch we can
already turn on. See [current transport](direct-transport.md).

Do not silently retain open sensors merely to preserve future startup ability.
A long-lived, idle camera/microphone service also needs a justified product and
policy design; a short experiment demonstrating eligibility is not proof that
Google Play will accept an indefinitely enabled service. If startup is blocked,
show an honest repair action rather than claiming that another checkbox or FCM
will fix it.

Before shipping, verify the real host's authenticated on-demand lifecycle,
sensor-off/revocation/disconnect cleanup, permission denial/revocation and OS
privacy toggles, resource contention, screen-off and process-recovery behavior.
Use emulators for reboot/credential cases. Update privacy disclosures, Data
safety answers and camera/microphone foreground-service declarations with a
demonstration of the actual user flow. A successful spike and Google's approval
are separate results.

Evidence: **Play policy/documentation reviewed**, checked 2026-10-31:

- [FGS declarations and camera/microphone demonstration requirements](https://support.google.com/googleplay/android-developer/answer/13392821?hl=en)
- [User Data policy: camera/microphone and prominent disclosure/consent](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en)
