# Camera and microphone implementation plan

Written 2026-10-31 at the owner's request. Deliver optional live camera viewing
and microphone listening in YepControl, with the same features available to
the web viewer and CLI through the shared encrypted client. Use **six
implementation phases**, with an independent Yep Anywhere review after every
phase, including final qualification.

The [spike](camera-microphone-spike.md) establishes sensor startup and cleanup on
Android 12 and 17, including fresh media-service startup while the Pixel is
securely locked. Its process, accessibility binding and control connection were
already alive. Production integration and FCM/process recovery need their own
acceptance. Preserve the executable probe as evidence rather than copying its
loopback transport or test entry points into the published app.

The owner's subsequent 2026-10-31 instruction authorizes proceeding autonomously
end to end and committing as work is verified. Execute the six phases and all
six independent reviews, followed by the existing deployment/Play delivery
process with internal installed acceptance before public promotion. Guarded
stored-PIN unlock for the authorized Pixel is in scope; physical reboot and
lock/debugging-setting changes remain excluded.

## Implementation record

- **Phase 1 complete, 2026-10-31:** additive [wire contract](media-protocol-v1.md),
  TS/Kotlin vectors and strict framing, and Room 4→5 migration for two independent
  default-off sensor settings. Existing identity/grant generations and opcodes
  are preserved; hosts do not advertise media until capture/transport integration.
  Pinned Node 24.22.1: 192 tests, workspace typecheck and Biome passed. Android
  protocol tests, ktlint, app lint/build passed; an owned API 35 emulator passed
  3 native UI and 24 storage/crypto/enrollment tests, including released-state
  migration. Independent Sol 6.1 High review through Yep Anywhere returned no
  remaining actionable Phase 1 findings after corrections to rejection semantics,
  boundary coverage, native command assertions and new result-code decoding.
  Detailed reviews and receipts remain private. Subsequent evidence follows.

- **Phase 2 complete, 2026-10-31:** independent native optional
  settings and normal Android consent, separate camera/microphone foreground
  services, Camera2 JPEG/H.264 with upright pixels, PCM recording, local Stop,
  permission/authority checks, lease/start deadlines and late-callback cleanup.
  The [noninstrumented acceptance fixture](../experiments/media-host/README.md)
  uses production capture code in a separate package. Moto/API 31 camera-only
  worked before microphone permission; Pixel/API 37 microphone-only worked before
  camera permission. Both passed combined front JPEG/rear H.264 plus PCM, local
  Stop, feature/owner revocation, canceled startup, lease expiry, fresh background
  screen-off capture and disconnect cleanup. Three-second H.264 samples decoded
  30/27 frames on Pixel (awake/locked ambient) and 36/37 on Moto (awake/asleep),
  with non-silent PCM and zero decoder errors. Pixel keyguard was independently
  secure, showing and locked before fresh startup. Cleanup removed fixture/tunnel,
  preserved other accessibility services and restored Pixel unlocked using one
  guarded delivery. Normal product APK excludes fixture code; app lint/build,
  ktlint/JVM protocol checks and 3 UI + 24 storage tests passed. Sensor hardware
  remains optional in APK feature filtering. No production transport, browser
  playback, FCM/process recovery, Doze or release claim is made by this fixture.
  Review corrections add separate restored permission launchers, five native
  consent/OS interruption tests, deterministic late-open/closed ordering tests,
  real notification PendingIntent Stop while backgrounded, and physical runtime
  permission-loss/process recovery acceptance. The final extra suite passed all
  five checks plus the 24 storage tests; the three navigation tests passed against
  the identical normal-host APK. Camera contention now maps synchronous platform
  busy errors to the existing busy reason. Independent Sol 6.1 High re-review approved Phase 2 with no remaining actionable findings.

- **Phase 3 complete, 2026-10-31:** native bounded/prioritized
  outbox and media command routing; the shared client has one reader/decryptor
  and serialized writer per lane, explicit bounded subscriptions, capability
  checks, cancellation and renewable leases. Stop/Renew can complete independently
  of an ordinary screen reply. Direct setup settles before sensor start; later
  route loss stops media and preserves ordinary relay recovery without replay.
  Unit coverage includes interleaving/out-of-order replies, blocked consumers,
  old hosts, cancellation, sequence rejection and nonce-writer serialization.
  The noninstrumented Moto test paired through the real native approval UI and
  production relay, then delivered real H.264/JPEG/PCM over forced relay and
  negotiated direct transport. Both lanes decoded media alongside normal screen
  capture; camera Stop confirmation measured 236/195 ms in the initial run.
  Paused consumers stopped native audio, connection loss released resources,
  and direct loss recovered screen control without restarting sensors. The test
  pairing was revoked and package/tunnel removed with other accessibility services
  preserved. Expanded checks cover camera feature revocation with continued audio,
  accepted-start cancellation and per-client pause. A reproduced renewal/release
  race now preserves the authoritative terminal reason; review also strengthened
  overflow and saturated-priority cleanup to close uncertain owners. Regression
  cases cover each ordering. Current checks: 205 TypeScript tests, workspace
  typecheck/Biome, 41 JVM tests/lint/build, and 3 native UI + 5 media + 24 storage
  checks passed. The final encrypted Moto run passed four feature-revocation/
  restart cycles per transport (eight total), zero decode errors, independent audio,
  and complete native/pairing/package/tunnel cleanup; camera Stop was 240 ms relay
  and 197 ms direct. Independent Sol 6.1 High review approved the final 21-file
  candidate after the three lifecycle corrections; no required Phase 3 validation
  or actionable finding remains. Browser playback, CLI and release acceptance
  remain in their later phases.

- **Phase 4 complete, 2026-10-31:** web Screen/Camera selection,
  front/rear and live/still options, explicit Start/Stop and independent Listen.
  Camera pixels use a separate canvas with no input bindings. Source changes wait
  for screen/camera Stop; microphone state remains visible in normal/fullscreen
  views. Sensor readiness, actual playback and terminal reasons remain distinct.
  AudioContext resumes in the Listen action, schedules at most 250 ms/16 chunks,
  drops stale queued sound on bursts/clock drift and closes with native Stop.
  Hidden/pagehide and playback suspension stop sensors without automatic resume.
  Browser fixtures verify real graph output, audio bursts, cancellation, independent
  permission readiness, input isolation, aspect/cropping and responsive fullscreen.
  Visibility handlers are simulated because automated Chromium keeps tabs visible;
  the phone runner separately pauses the entire real JavaScript engine/renewal loop
  after a confirmed debugger event. A freeze-request probe kept firing 233 clock
  ticks and five renewal ticks; it is not counted as a stalled-page test.
  Existing viewport/unlock regressions and 211 TS tests passed. Native API 35 smooth
  view passed browser/source handoff, cancellation, rapid-toggle and permission
  regressions. The real viewer has rendered camera and microphone output over both
  encrypted paths on Moto. The corrected real-viewer run passed both transports,
  front JPEG/live H.264, actual graph output, feature/local Stop, playback suspension,
  connection loss and explicit reconnect without capture. Native sensors released
  within the 22.5-second confirmed-pause observation and stayed off after resume;
  fixture pairing/package/tunnel cleanup passed. Multi-phone preview/live geometry,
  compact cancellation, pairing/refresh and cross-tab authority regressions passed.
  The stronger audio observer measures signal on the production destination path.
  Final typecheck/Biome/format and diff checks passed. Independent Sol 6.1 High
  re-review approved the final 27-file candidate with no remaining actionable
  findings or required Phase 4 validation.

- **Phase 5 complete, 2026-10-31:** bounded CLI JPEG snapshot/sampling and
  PCM WAV jobs, private exclusive artifact publication, independent continuous
  draining and persistent agent start/receive/Stop. Jobs use the shared encrypted
  client and preserve legacy screen commands. Stop waits for native release;
  cancellation, EOF, blocked output and hard deadlines have bounded cleanup.
  Real Moto CLI acceptance decoded rear/front JPEGs, exact one-second audio,
  concurrent sensors and recent audio. Independent Stop and unread-output SIGTERM
  released native resources; pairing/package/tunnel cleanup passed. Subprocess
  tests cover real encrypted relay interoperability and legacy refusal; process
  tests cover blocked output cancellation and automatic deadlines. The full suite
  passed 224 TS tests before a review correction; nine targeted media tests pass
  afterward. The correction makes Stop-all cancel earlier queued starts while
  preserving later explicit starts. Final typecheck/build/Biome/diff checks pass.
  Independent Sol 6.1 High re-review approved the final 16-file candidate with no
  remaining actionable findings or required Phase 5 validation.

## Product behavior

The Android app has two optional settings, initially off: **Allow remote camera**
and **Allow remote microphone**. Each explains use by enabled paired controllers
and requests only the corresponding Android permission. Existing global and
per-controller access switches remain authoritative. Stored preferences and
actual OS permission/service readiness are separate states. Pairing and screen
control remain useful when either permission is denied.

The web viewer starts in **Screen** mode. A **Camera** view provides Start,
front/rear selection when available, and Stop. The viewer presents one video
source at a time; returning to Screen stops the camera. Screen gestures and
navigation belong to Screen mode. **Listen** independently starts or stops the
phone microphone in either view, with a persistent active indicator. Listen Off
stops native microphone capture, rather than merely muting browser playback.
Receiving remote media does not request the browser's own camera/microphone.

The phone shows an active-media notification with the connected controller and
Stop sharing. Stop, access revocation, permission loss, disconnect and expired
media leases release native resources. Local Stop cancels the active media
session; a controller must deliberately start again. The phone's feature/access
switches control continued authorization. Connecting, reloading, recovering a
transport or reconnecting never silently starts sensors.

The initial CLI interface is:

```sh
yepcontrol camera snapshot --out photo.jpg
yepcontrol camera frames --fps 1 --duration 10s --out-dir frames/
yepcontrol microphone record --duration 10s --out audio.wav
```

Persistent `session --stdio` also provides explicit camera/microphone start,
receive and stop operations. A one-shot process captures a bounded artifact and
closes its session; a live subscription belongs to a persistent client. Local
output paths stay at the client. JSON replies/events carry stream identifiers,
format, timestamps, dimensions/duration and artifact paths. Continuous media
does not flood JSON stdout with base64. The agent chooses its own image/audio
analysis tools; the phone and relay need no AI runtime or transcription service.

## Implementation defaults

- Keep the existing paired identities, phone session ownership, encrypted relay
  and optional direct transport. WebRTC currently carries encrypted data-channel
  records; reuse that route and the encrypted WebSocket fallback.
- Add capability-gated operations and media records. Existing public hosts,
  clients and pairings retain their wire behavior. New clients refuse unsupported
  media operations locally; new hosts send media only after an explicit supported
  request. Do not renumber existing opcodes or replace pairing authority.
- Use JPEG for snapshots/sampled frames, the existing Android H.264 encoder
  architecture for live camera video, and initially PCM16LE mono at 16 kHz for
  microphone transport/WAV artifacts. PCM is about 32 kB/s before overhead and
  avoids adding a codec dependency for the first release. Browser playback and
  latency still require qualification; change the format only with corresponding
  capability/codec tests and review.
- Use one owned native media controller for the active phone session, with
  independent camera and microphone lifecycle. Advertise hardware support,
  feature authorization, OS readiness and actual stream state separately.
  Starting is not Live until useful media arrives.
- Keep a bounded stream identifier/generation, timestamps, queues, start
  deadlines and renewable media lease. Prioritize Stop and control traffic over
  media. Preserve one nonce allocator/writer per cryptographic transport lane;
  logical stream identifiers do not justify key/nonce reuse.
- Keep native recording off by default. The requesting client writes artifacts
  only when requested. No relay recording or public unauthenticated media URL.

## Six implementation phases

### Phase 1 Baseline and media contract

Record the current revision, existing working-tree changes and relevant passing
checks using the pinned toolchain. Preserve concurrent edits and the spike.
Specify additive capabilities, start/stop/capture operations, media framing,
result codes, stream ownership, limits and state transitions. Define how the
shared client distinguishes command replies from media without competing reads.

Add storage for the two disabled-by-default phone settings with a real migration
from released data. Preserve existing grants and access/unlock settings. Define
the live authority checks for starts, asynchronous completions and revocation.
The contract supports camera-only, microphone-only and combined use.

**Exit evidence:** TS/Kotlin vectors and malformed-message coverage, released
state/old-client interoperability, migration/default preservation, and baseline
control/pairing checks. No physical setting changes are needed for this phase.
**Review focus:** compatibility, authority, nonce ownership and protocol bounds.

### Phase 2 Android capture and feature setup

Implement the two native settings, disclosure/permission flows, readiness and
active notification/Stop action. Build production Camera2 capture, still-image
output, H.264 camera encoding and AudioRecord capture behind the session owner.
Reuse encoder/resource primitives where appropriate; keep MediaProjection
consent and screen capture separate from camera/microphone permission.

Derive foreground-service types from the sensors actually requested and
authorized. Camera-only use must not require microphone permission, and vice
versa. Handle front/rear availability, orientation, resource contention, privacy
controls, canceled starts, permission loss and late callbacks. Release the last
sensor and foreground service when no active media remains.

**Exit evidence:** meaningful native lifecycle checks plus separate-package
physical acceptance on the authorized Moto and Pixel. Verify camera-only,
microphone-only, both, denial, local Stop, screen/ambient sleep and secure lock.
Use a noninstrumented fixture that exercises the production capture controller
for background eligibility; app instrumentation can lend launch privileges and
must not qualify that case. Fixture entry points stay outside the release APK.
Keep the published app and its pairings installed.
**Review focus:** independent permissions, foreground eligibility, stale callbacks
and sensor/resource release.

### Phase 3 Encrypted streaming and shared client

Implement media framing/routing in `protocol/`, Android and `client/`. Give the
shared client one receive path that dispatches command replies and media to the
correct owner, with bounded queues and a control-priority writer. Use the same
encrypted content over relay and direct lanes. Change relay code only where
opaque framing/flow limits require it; the relay never decodes media.

Complete bounded direct-path selection before starting media, or cancel the
pending upgrade, so the routine delayed upgrade cannot immediately terminate a
new camera session. On later transport loss, release the old owner, establish
a fresh command owner and show media stopped. Fresh lanes use fresh handshake
keys; a retained authenticated relay keeps its existing monotonic nonce counters. Do not replay an uncertain
start or automatically resume capture.

**Exit evidence:** actual host-to-client media over forced relay and direct
transport, interruption/handoff, blocked receivers, lease expiry, stale stream
rejection, cancellation/revocation and responsive Stop/control while streaming.
**Review focus:** receive/write ownership, encryption, backpressure and recovery.

### Phase 4 Web camera and listening controls

Add Screen/Camera selection, explicit Start/Stop, camera choice and independent
Listen. Decode/render outside high-frequency React state updates. Resume browser
audio from the deliberate Listen action and keep buffering bounded. Preserve
phone layout, touch coordinates and screen-sharing behavior; camera pictures
must never become screen-touch targets.

Expose clear Starting, Live, Off and failure states, including unsupported app,
permission required, camera busy and lost connection. Keep active microphone
state visible while changing views. Do not retain a live source across reload
or reconnect. Support compact mobile controls, keyboard access and fullscreen.

**Exit evidence:** isolated test-browser acceptance for layout, source switching,
playback, denied permissions, local Stop/revocation, background-tab behavior and
reconnect; retain real screen-input/smooth-view regressions. Verify actual audio
playback/decoded signal, beyond the spike's packet/nonzero-sample checks.
**Review focus:** visible sensor state, truthful readiness, audio buffering and
existing viewer behavior.

### Phase 5 CLI and agent media operations

Add the bounded snapshot, sampled-frame and microphone-recording commands and
corresponding persistent-session operations using `client/`. Use owner-only
artifacts, refuse accidental overwrite/symlinks, and provide stable structured
errors. Publish useful format/timestamp/source metadata. Keep bytes off routine
logs and local artifact paths off the phone protocol.

Keep stdout machine-readable and progress on stderr. Bound subscriptions,
artifact size/duration, output queues and shutdown. Ctrl-C, closed stdin,
blocked output, client termination or lost transport must release or expire the
phone's media owner. The new media operations do not add PIN entry to the CLI.

**Exit evidence:** real CLI subprocess/crypto tests and CLI-to-native encrypted
acceptance with independent image/audio/OS witnesses, including slow output,
interruption and cleanup. ADB may set up/observe fixtures, not deliver the CLI's
media commands. **Review focus:** output contract, bounds, capability checks and
artifact/session cleanup.

### Phase 6 Combined qualification and release candidate

Run the complete native/web/CLI matrix against the production components:
separate and combined sensors, permission/feature revocation, global/per-client
pause, secure lock and noninteractive states, socket-absent FCM wake, process
recovery where reproducible, missing accessibility binding, network/transport
loss and teardown. Distinguish process reclamation, user force-stop and device
idle. User force-stop may require explicit local recovery. FCM remains a wake
hint followed by normal authentication, not a media command channel.

Use owned emulators with synthetic credentials for reboot/first-unlock and
upgrade matrices. Test released host/client combinations and in-place migration
with existing pairings. Use the physical phones within the unlock procedure
below; do not reboot them or change lock/debugging settings. Recheck baseline
screen viewing, accessibility commands, smooth video, pairing and saved grants.

Update privacy/disclosure text, permission/foreground-service declarations,
release notes, CLI help and deployment/rollback instructions. Build the signed
candidate through the existing release process with the next unused version
code, using build/sign steps without triggering publication before release is
authorized. Keep signing/IAM/tester data private. Prepare internal Play delivery and
in-place acceptance on an already-paired phone for the authorized release run.

**Exit evidence:** a reproducible candidate, compatibility and cleanup receipts,
measured latency/buffering, device-specific limits and no outstanding actionable
review findings. **Review focus:** the complete acceptance record, upgrade and
release safety. Review this phase before any public promotion.

## Independent review after every phase

Use the owner's requested **Yep Anywhere API at `http://localhost:3400`** with
provider **`codex`**, model **`gpt-6.1-sol`**, **High** reasoning and
**bypass permissions**. The running API/catalog were checked on 2026-10-31:
the provider is enabled/authenticated and advertises this model and High effort.
Source review of the creation route confirms the request below. Recheck the
running API and applied settings when launching each reviewer; no review has
been launched merely to write this plan.

1. Implement the phase and run its relevant checks. Prepare the exact baseline,
   candidate revision/diff and file manifest, including new/untracked files.
2. Resolve the repository project ID through `GET /api/projects`, rather than
   hardcoding a path-derived private ID. Confirm readiness/model availability
   through `GET /api/version` and `GET /api/providers`.
3. Create a fresh reviewer with
   `POST /api/projects/{projectId}/sessions` and this request shape:

   Send `Content-Type: application/json` and `X-Yep-Anywhere: true` on mutating
   API requests; the latter is the existing request-protection header.

   ```json
   {
     "provider": "codex",
     "model": "gpt-6.1-sol",
     "thinking": "on:high",
     "mode": "bypassPermissions",
     "message": "Review phase N of docs/camera-microphone-plan.md. Read repository instructions, the phase scope, actual candidate diff/new files and supplied validation evidence. Return actionable findings with file locations, impact and missing validation. Review only: do not edit, commit, deploy, access credentials or operate physical devices."
   }
   ```

4. Store the returned session/project IDs privately. Verify the actual provider,
   resolved model, High effort and applied bypass mode using session/process
   metadata, including `GET /api/sessions/{sessionId}/process`. The create API's
   High field is `thinking: "on:high"`; do not guess an `effort` request field.
5. Follow completion with bounded waits and read the final report from
   `GET /api/projects/{projectId}/sessions/{sessionId}?tailTurns=2`. Do not mistake
   queued, idle-without-report, failed or waiting-for-input for approval. On an
   uncertain create response, reconcile existing sessions before resubmitting.
6. Fix actionable findings, rerun affected checks and request re-review in that
   phase's reviewer session through `POST /api/sessions/{sessionId}/messages`.
   Send the actual corrections/diff in its `message` field. If its process has
   been reaped, resume that same session through the project session resume
   endpoint with the verified model/thinking/mode before delivering the message.
   Do not advance without a completed review
   covering the final candidate. A model/API failure is not a passed review and
   must not silently select a different reviewer/model.
7. Commit the verified phase on the current branch, staging only task-owned
   files, with the repository's required model trailer. Record the approved
   revision, tests and review disposition. Start a fresh reviewer for the next
   phase; retain the previous one for correction rechecks.

Review bypass permissions allow inspection/tools; they do not authorize a
reviewer to change phones, read secrets or publish. Keep review prompts,
responses, session IDs, screenshots and detailed receipts under ignored
`.local/media-access/implementation/`. Public documentation carries sanitized
results. Do not change YA defaults, authentication or provider configuration.

## Unlocking an authorized physical phone

Do not assume a locked test phone requires an on-site person. The configured
Machine Control route successfully unlocked the Pixel during this investigation.
It is a controller-held PIN route, independent of whether YepControl's own
phone-local saved PIN is enabled. The current YepControl CLI does not expose
secure unlock. Do not read the phone's PIN vault to check its contents.

Use the common CLI and Android handheld guide from the `machine-control`
checkout. Concrete aliases, selectors and the tested Pixel coordinates are in
the ignored private implementation runbook; they do not belong in public Git.
The portable procedure is:

```sh
machine-control targets
machine-control inventory credentials TARGET
machine-control --target TARGET target doctor
machine-control --target TARGET testbed -- wake
# If needed, expose the PIN keypad with an observed ordinary lock-screen swipe.
machine-control --target TARGET testbed -- unlock --json
machine-control --target TARGET target doctor
```

Select the exact authorized device from private inventory. Credential discovery
reports a locator and readiness, not the PIN. Let the dedicated unlock helper
read and deliver that configured secret; never `cat` it, put it in arguments,
copy it into an environment variable or write it into evidence. A locked-state
doctor can return nonzero with valid JSON; inspect the report rather than
treating that as a missing credential or disconnected phone.

The Pixel initially showed its notification/fingerprint surface. A central swipe
interacted with the fingerprint target; a side swipe exposed PIN entry. The
helper's initial refusals had `attempts=0` and delivered no credential. After a
new surface observation, one guarded submission confirmed unlock. If a preflight
refuses with zero attempts, diagnose the surface/policy without guessing a PIN.
If delivery fails or its outcome is uncertain, stop; do not automatically retry
or switch credential transports. Each distinct new lock event allows one fresh
guarded attempt within the owner's authorization.

Require independently confirmed unlocked keyguard and available user storage
before permission/setup work. Accept only the helper's supported policy checks;
never weaken lockout, lock settings or debugging. Reboots/first-unlock tests
remain on owned emulators. After screen-off physical tests, remove owned test
packages/tunnels, preserve other services/pairings, and restore the authorized
phone to an unlocked usable state through the same guarded route when needed.

## Autonomous execution and release boundary

The implementation loop is **implement → test → independent review → fix →
re-review → commit → next phase**, without human confirmation between phases.
Maintain concise progress updates and durable phase receipts. Resolve ordinary
reversible implementation/test issues autonomously and preserve concurrent work.
Do not silently skip a required review or weaken acceptance to finish.

When feature release is authorized, use the existing CI signing/publication and
Cloudflare deployment paths. Preserve compatibility when deploying web/relay
before the app update. Deliver the exact candidate internally through Play,
verify an in-place update and existing pairing on the physical phone, then
promote that same accepted artifact to the authorized public rollout. Record
submission, Google approval and actual availability separately. No stale Pi
authority is reactivated.

If release is not yet authorized, phase 6 finishes with a reviewed candidate,
concrete deployment/publication changes and acceptance instructions ready for
the final release decision. A real missing credential, unavailable reviewer or
external Play gate is reported with the specific remaining action; routine
development does not acquire additional approval steps.
