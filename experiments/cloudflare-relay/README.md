# Cloudflare relay runtime proof

Local protocol, live transport, and Android/browser product proofs completed 2026-10-22. This experiment is outside
the production workspace and its dependency graph. It is not a deployable
replacement for the Node relay. The checked-in Wrangler config disables public
routes, workers.dev and preview URLs, uses `https://proof.invalid`, and refuses
all requests unless a
`PROOF_KEY` binding and matching fixture header are supplied. The test generates
that key only in memory for local runs. The local suite needs no Cloudflare
account, DNS, Firebase credential or real phone. Live runs use a separate gated
workers.dev service; see the receipt below.

With the repository's pinned Node 24 and pnpm:

```sh
cd experiments/cloudflare-relay
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

`build` is a Wrangler **dry run**. `test` runs its bundle in Miniflare/workerd,
uses disposable SQLite-backed Durable Objects and synthetic endpoint identities,
uses real loopback WebSockets for transport, then disposes the runtime and removes its temporary storage in `finally`.
Wrangler 4.149.0 uses Miniflare 5.20261006.1-alpha; this experiment pins the same
version and its development-only eviction API. Revisit that tooling before
promoting any code. Production dependencies are unchanged.
The workspace overrides Miniflare's exact `undici` pin to
[`7.30.1`](https://github.com/nodejs/undici/releases/tag/v7.30.1) for its security
fixes, without changing the pinned emulator runtime (reviewed 2026-10-25).

## What passed locally

- Invalid creation signatures are rejected before allocating an object.
- Signed enrollment and concurrent duplicate creation/completion have one winner.
- Each pairing's phone/viewer sockets meet in one SQLite-backed object.
- The existing protocol library performs its real encrypted handshake and
  authenticated record exchange. The relay forwards ciphertext.
- Explicit runtime eviction with `webSockets: "hibernate"` preserves authenticated
  sockets and attachment state; the next encrypted record succeeds.
- Ninety 16 KiB encrypted records, paced at 30/second for three seconds, pass at
  3.93 Mbps of plaintext payload. Observed local p95 exchange time was about
  5 ms. This is synthetic local traffic, not a video/network/cost benchmark.
- The authentication alarm closes an idle unauthenticated socket with code 4003.
  A real loopback WebSocket observed clean closure at about 20 seconds for a
  10-second authentication deadline; hosted close/cleanup timing remains to be
  checked. The test allows 45 seconds and reports the measured time.
- Durable global/per-target wake budgets refuse excess requests and retain their
  counters across object eviction. Abrupt transport loss closes its peer and
  permits a fresh authenticated connection.
- Duplicate viewer and wrong-key revocation are refused; a valid phone revocation
  survives disposing and recreating the entire runtime against its stored state.

## Findings and deliberate gaps

The front Worker needs the pairing ID **before** choosing an object. This proof
uses `/api/socket?id=…`, then requires the signed authentication ID to match the
stored pair. Normal Android and browser builds supply the same routing field;
the Node relay also accepts the older bare `/api/socket` route. The ID remains routing metadata,
not proof of authority. Query strings must not become identifiers in request logs.

Hibernation requires `acceptWebSocket`, serialized attachments, and no ordinary
per-socket timers. Alarms enforce authentication/session/invitation deadlines.
Authentication re-reads authority after crypto awaits; persistent state must win
against revocation and duplicate attempts. The Node relay is not refactored into
a generic multi-backend framework for this experiment.

The fixture gate is not a proposed product login or production abuse policy.
The bounded admission directory now refuses unknown reads/upgrades before pairing
object allocation and caps signed reservations, request/upgrade rates and socket
leases. Valid self-generated enrollment signatures do not establish a scarce
identity. Public enrollment fairness, reservation lifecycle, monitoring and spend
containment remain open; see [limits and tests](../../docs/cloudflare-hardening.md).
The proof adds
a durable send budget of 100/minute globally and 10/minute per FID, plus a
30-second per-pair cooldown; these are fixture bounds, not a public abuse policy.
Do not expose this Worker anonymously.

The product proof now implements management sockets, access policy/generation
synchronization, push registration/removal, viewer refusal codes and FCM wake.
Wake requests retain viewer-session/request/generation binding, expiry and
coalescing in durable state. A separate SQLite object bounds sends across pairs.
The sender now obtains short-lived OAuth tokens from a dedicated service-account
key stored as a Worker secret. The global wake-budget object coordinates renewal
and persists the token cache/backoff across restarts. See
[credential renewal and rotation](../../docs/cloudflare-fcm.md). The original
product proof below used a manually supplied token; it is historical evidence.

Held HTTP polls, heartbeat qualification,
network diversity and a representative operating-cost sample remain open.
Receive ACKs now bound unacknowledged data across hibernation; a stalled receiver
ends the route rather than accumulating ciphertext without an application bound.
The platform's 32 MiB receive limit does not replace our own 1,048,608-byte binary
record limit. Keep that application bound. See the actual Android, FCM, decoded
video and metered-usage receipt below, and [hosting direction](../../docs/hosting-and-turn.md).

## Live test runner

`pnpm test:live` targets only an explicitly configured, secret-gated
`yepcontrol-relay-proof.*.workers.dev` deployment. It requires
`PROOF_LIVE_CONFIG` and `PROOF_LIVE_SECRETS` pointing to private JSON files.
Concrete account, hostname, secrets and deployment receipts belong in private
infrastructure records. The runner refuses the production origin.

Deploy with the pinned Wrangler, a separate SQLite Durable Object namespace,
workers.dev enabled, preview URLs disabled, and the fixture secret supplied via
`--secrets-file`. Configure `PROOF_EXPIRES` to at most two hours in the future;
the Worker refuses new requests after that time. Disable invocation logging for
the proof so URLs carrying fixture IDs are not collected as request logs.
The default checked-in config remains local-only and closed.

The live suite uses one synthetic pairing, actual HTTPS/WSS and the existing
E2E implementation. It bounds streaming to 900 encrypted 16 KiB records over
30 seconds, checks both directions, a five-second paused receiver, the exact
record-size boundary, wrong keys/routing IDs, duplicates, idle
hibernation via a changed constructor boot ID, authentication alarms, abrupt
loss/reconnect and revocation. It redeploys only that proof Worker to verify
revocation survives code replacement. Every client socket is terminated and
completed fixture authority is revoked during cleanup. Reports and deploy logs
stay beside the private config. This runner does not implement Android, FCM or
TURN support.

## Live Cloudflare receipt — 2026-10-22

Two bounded protocol runs passed against an actual deployed Worker and its own
SQLite-backed Durable Object namespace, using synthetic endpoints over HTTPS/WSS.
The Pi service and production hostname were unchanged. Invocation logging was
disabled; fixture IDs, secrets, account details and raw evidence remain private.

| Measurement | First run | Second run |
| --- | --- | --- |
| Stream | 900 × 16 KiB records / 30 seconds | Same |
| Payload throughput | 3.93 Mbps | 3.93 Mbps |
| Sender-to-receiver median | 32.5 ms | 26.0 ms |
| Sender-to-receiver p95 | 146.6 ms | 37.1 ms |
| Maximum observed latency | 359.5 ms | 96.9 ms |
| Idle unauthenticated clean 4003 close | 10.16 seconds | 10.11 seconds |

Both runs verified signed pairing with one concurrent winner, rejection of wrong
keys/routing IDs, the actual bidirectional E2E handshake and records, duplicate
viewer refusal without displacing the live session, abrupt disconnect with peer
closure, fresh reconnect, and phone-signed revocation disconnecting both sides.
Revoked state and refusal survived an actual Worker redeployment with a distinct
build marker, not just a local runtime restart.

Real hibernation was observed in both runs after 25 seconds without application
traffic: the constructor boot ID changed, both authenticated socket attachments
remained, and encrypted exchange resumed on those same sockets.

The second run additionally paused the viewer's network reader for five seconds
while sending 150 encrypted 16 KiB records; all were received and authenticated
in order after resume. A maximum-size 1,048,608-byte encrypted record passed.
A 1,048,609-byte message was rejected with 4003, its peer disconnected, and a
fresh session worked. The bounded pause test does not qualify indefinitely slow
peers or prove a production queue/memory bound.

These are one machine's synthetic endpoints traversing Cloudflare, not two
independent mobile networks or decoded H.264. The jitter difference between runs
is part of the result. Do not use a single p95 sample as a video responsiveness
or availability guarantee.

Initial narrow-window GraphQL queries returned no populated counters. The later
product proof recovered actual metrics with a 24-hour query and checked the
authenticated billing dashboard; see the receipt below. Empty analytics arrays
were not evidence of zero usage.

All test grants were revoked and client sockets closed. After testing, admission
was closed by deploying an expired `PROOF_EXPIRES` value and verifying that even
the valid fixture key receives 403. Reopening requires an explicit new short
lease in the private config. The namespace is retained for further investigation;
this is not a public service or production cutover.

The subsequent product receipt below supersedes the original Android/FCM/video
gaps. Network diversity, sustained slow-peer behavior and representative cost
remain open. Pi coturn is still a separate, unimplemented direction.


## Live Android/browser product receipt — 2026-10-22

The separate gated Worker now serves the actual React viewer and accepts a
private debug Android build. An owned API 35 Google APIs emulator and bundled
Playwright Chromium exercised public HTTPS/WSS. No physical-phone settings,
production origin, Pi service, Play release or DNS were changed. Concurrent
dependency upgrades were left intact; acceptance used an isolated source
snapshot of the previously pinned toolchain and archived proof APKs.

- Scanned the rendered QR, approved the normal native Grant UI, and completed
  the existing end-to-end encrypted exchange.
- Enabled automatic wake, verified the app process was absent and there was no
  application socket, then requested connection from the browser. Cloudflare
  itself sent FCM HTTP v1; a fresh native receipt and encrypted exchange were
  recorded. Three clean complete runs measured receipt/exchange at 1,217/1,612 ms,
  1,027/1,499 ms and 931/1,436 ms, with clock-estimate uncertainty of 8–9 ms.
- Preserved pairing across Android process restart and browser reload; native
  signed revocation removed authority and subsequent access was refused.
- Forced WebRTC construction to fail, making WebSocket relay the only lane.
  Approved native screen access and MediaProjection consent. Actual H.264
  `VideoFrame`s decoded and rendered in the browser: **77 frames in 5.003 s**,
  with **1,355,057 incoming binary WebSocket bytes** (about **2.17 Mbps**).
  This count includes encrypted relay traffic during that interval, not just
  elementary video bytes or a maximum-throughput benchmark.
- Verified real native taps, Unicode text and IME dismissal, swipes, navigation,
  app launch, global access disable closing the session, re-enable and removal.
  The browser reported no page errors. Both fixtures were revoked and cleaned up.

These are real native/product paths through Cloudflare from one test machine.
They do not qualify physical-phone background survival, natural Doze, reboot,
independent networks, TURN, saved-PIN unlock or production availability.

### Metered usage and billing

Read-only inspection of the authenticated Cloudflare dashboard confirmed
**Workers Free active** and **$0.00 Durable Object billable cost** for the current
cycle. The proof Pairing namespace showed about **2.33k raw invocations,
3.18 GB-s duration and 40.96 kB stored** at the initial billing check. GraphQL
independently returned 2,408 rows read and 95 rows written for that namespace.
After product acceptance, a later query showed 3,252 raw invocations,
4.93 GB-s, 3,301 rows read and 154 written. These cumulative counters include
earlier synthetic tests and native acceptance; they are not a video-only price.
Counters can increase as analytics arrive.

Incoming hibernatable messages appear as invocation type `hibernation`, rather
than the periodic inbound-message counter. Raw invocation counts are not billed
request units: the published 20:1 incoming-message ratio applies only to billing.
The dashboard also exposed five earlier close-handler exceptions: reserved
observed close codes such as 1006 must not be echoed in a close frame. The proof
now normalizes these codes; abrupt-loss/reconnect regression coverage was added.
A final version-filtered query confirmed zero script exceptions in the product
and corrected Worker versions; all five earlier exceptions belonged to the
synthetic versions. Final Pairing duration was 6.96 GB-s, with another 0.011 GB-s
for the send-budget object; SQL counters were 6,928/276 reads/writes and 8/25
respectively. No CPU or memory limit errors appeared in these counters.
See [metrics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
and [pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
reviewed 2026-10-22. Free-tier limits fail operations when exceeded; $0 here is
an observed small-test result, not proof of free production capacity or a posted
invoice. A representative long video/idle/wake cost sample remains separate.

### Repeating native acceptance

Use a fresh short lease, the isolated proof hostname and owner-only secrets.
Build the viewer with `VITE_PROOF_RELAY=1`; configure it as Wrangler static assets
with `run_worker_first=true` so the fixture gate protects every request. Build
debug APKs with `YEP_PROOF_RELAY_KEY_FILE` pointing to an owner-only file containing
the gate key, and `-PsharingWebsite` set to the proof origin. Release builds keep
`PROOF_RELAY=false` and an empty key even when that environment variable exists.
Never distribute these private debug APKs or bake the key into viewer JavaScript.

Set `HOSTED_ORIGIN`, `HOSTED_PROOF_SECRETS`, and a dedicated
`HOSTED_STATE_DIRECTORY`; optionally set an unused even `HOSTED_EMULATOR_PORT`.
The runner injects a Secure, HttpOnly, host-only fixture cookie, and refuses
physical-device proof admission. `HOSTED_APK_DIRECTORY` can point to an archived
APK output tree to avoid concurrent builds. Run `HOSTED_FCM=1 pnpm test:hosted`,
then `HOSTED_VIDEO=1 pnpm exec tsx scripts/hosted-acceptance.ts --control`.
Keep `HOSTED_DIRECT` unset to force WebSocket fallback. Revoke fixture grants,
remove the ephemeral sender token, close admission and verify valid-key 403
when finished. Private configs, tokens, APKs and evidence stay out of Git.

Final verification passed the full live transport suite (including actual
redeployment), local cryptographic/hibernation/quota regression tests, FCM sender
contract tests, type checks, 130 application TypeScript tests, Android Kotlin
compilation, ktlint and lint. Current-toolchain compile/lint/tests also passed
after the concurrent dependency upgrade landed. The exception-filtered live tail
recorded no new error events during final regression. All grants were revoked,
owned test processes reaped, the FCM secret deleted and valid-key admission
verified as 403; Pi health retained its existing deployed revision.
