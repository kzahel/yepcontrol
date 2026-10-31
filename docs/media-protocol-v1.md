# Camera and microphone protocol

Implementation contract, 2026-10-31. Media is optional on the existing v1
control session. `ControlState.media` advertises version 1 only when the host
implements these operations. Existing command numbers, replies and identity
handshakes are unchanged. An old host lacks this capability; clients must not
send media requests to it. New hosts never send unsolicited media to an old
client. All commands and packets remain application-encrypted.

## Control operations

Append to ARC1: 24 `cameraStart`, 25 `microphoneStart`, 26 `mediaStop`,
27 `mediaRenew`. Each retains the existing monotonically increasing command ID
and ordinary result acknowledgement. Acknowledgement accepts the request, not
proof of working media. Camera start adds a positive signed-32-bit stream ID,
facing byte (1 rear, 2 front), format byte (1 JPEG, 2 H.264) and FPS byte (1–5
JPEG, 1–30 H.264). The other operations add a 32-bit stream ID; Stop alone permits
zero to mean all media owned by this session. Stream IDs may not be reused
within a session. Late records for closed/replaced IDs must be discarded.

Camera and microphone have separate IDs and authorization. Each checks current
pairing/session authority, its local feature setting, runtime permission and
hardware readiness. Stop needs neither an unlocked phone nor continued feature
permission. Renew extends only an existing owner; it never opens a sensor.
The lease is 20 seconds, renewed every 5 seconds. A start must produce useful
media within 10 seconds or end. Closing a controller, local Stop, authority or
permission loss ends its capture. A new connection never inherits live media.

### Acknowledgements, rejection and terminal outcomes

A start returns result 0 only after reserving its stream and accepting startup;
that is not Live. Send the acknowledgement before its starting event. A rejected
start sends one nonzero result and **no ARM1 records**. Existing result meanings
are preserved: 4 unavailable (unsupported hardware/facing/format, duplicate ID or
exhausted start budget), 6 busy (sensor already owned), 7 interrupted, 8 session
ended. Add result 10 for missing sensor permission and 11 for its disabled local
feature. No result 3 (phone locked) is implied by media access. Whole-session
revocation may close transport instead of replying. The client must never retry
an uncertain start automatically.

Every syntactically valid start consumes its proposed ID, including a rejected
start. Keep at most 1024 consumed IDs per authenticated session; further starts
return 4 until a fresh session. Reusing an ID returns 4 without affecting the
previous stream. This bounds replay tracking. Only a successful start owns a
stream and requires a terminal outcome.

Stop returns 0 for an active, already-closed or unknown ID (including 0/all);
it is idempotent and never opens a sensor. Renew returns 0 only for an existing
active/starting stream of this owner, otherwise 4. Neither consumes an ID. Local
Stop or lease/start timeout also does not authorize another start.

After acceptance, every stream emits at most one terminal event: phase 2/off for
explicit Stop (reason 7/stopped), or phase 3/error for permission (1), disabled
feature (2), busy resource (3), unavailable hardware (4), disconnect (5), startup
or lease timeout (6), or interruption (8). A disconnected/invalid transport may
prevent delivery; its local closed state is terminal. Native release happens
before the terminal event. Closed IDs never emit more frames. ARM1 sequences
increase across starting, payload and terminal records; the first useful payload
makes the stream Live. Lost records are allowed, duplicated/decreasing sequence
numbers are not. The reason indexes in ARM1 are distinct from result codes.

## ARM1 packets

Media records have a distinct magic so a single shared-client reader can route
them without consuming a command reply. Every integer is big-endian. Maximum
record size is 1 MiB, inside the existing encrypted-record bound.

| Offset | Bytes | Value |
| --- | --- | --- |
| 0 | 4 | ASCII ARM1 |
| 4 | 1 | Kind: 1 JPEG, 2 H.264, 3 PCM, 4 lifecycle event |
| 5 | 1 | Flags: bit 0 is H.264 keyframe; all other bits zero |
| 6 | 2 | Reserved zero |
| 8 | 4 | Positive signed-32-bit stream ID |
| 12 | 4 | Positive unsigned-32-bit sequence, monotonically increasing per stream |
| 16 | 8 | Nonnegative monotonic capture timestamp in microseconds, JS-safe integer |
| 24 | 4 | Image width, or PCM sample rate, or zero for event |
| 28 | 4 | Image height, or PCM channels, or zero for event |
| 32 | remaining | Payload |

Image dimensions are 1–4096 each and at most 16,777,216 pixels. JPEG starts with
its SOI marker; H.264 uses Annex B start codes. PCM is signed 16-bit little-endian,
16,000 Hz mono, with even payload size 2–6400 bytes (at most 200 ms). Lifecycle
events contain two bytes: phase 1 starting, 2 off, 3 error; then reason 0 none,
1 permission, 2 disabled, 3 busy, 4 unavailable, 5 disconnected, 6 timeout,
7 stopped, 8 interrupted. Starting requires reason none; error requires a reason.
Live state follows the first useful media, not a starting event.

The native producer and client use bounded mailboxes. Stop/control replies take
priority; stalled producers/receivers do not grow queues or keep a sensor
indefinitely. Dropped encoded video requires a fresh keyframe before decoding
resumes. Shared cryptographic writers allocate record numbers across all logical
streams; stream IDs do not allocate or reset cryptographic nonces.

## Readiness and compatibility

The optional state has required inner fields: `v: 1`, `camera`, `microphone`.
Each sensor reports `available`, `allowed`, `permission`, `stream`, `phase`
(off/starting/live), and `reason`. Camera additionally reports front/rear
availability. A running state requires a positive ID and reason none. Hardware
availability, owner authorization, OS permission and actual capture are distinct.
The complete control-state response stays within the existing 2048-byte bound.

Room version 5 adds `cameraAllowed` and `microphoneAllowed`, both false by
default, without rewriting grants, generations or unlock authority. Changes to
these sensor settings stop affected media while retaining ordinary control.

Shared wire fixtures are `protocol/vectors/media-v1.json`, checked independently
by TypeScript and Kotlin. The controller enforces subscription IDs/sequences and
capability checks in addition to the transport's authenticated replay checks.
