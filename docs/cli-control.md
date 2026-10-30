# CLI pairing and accessibility control

Owner-authorized 2026-10-30: implement a shared web/CLI client, terminal pairing,
and basic accessibility observation and control, with owned-emulator acceptance.
After each implementation phase, request an independent Sol 6.1 High review via
the Yep Anywhere API with bypass permissions, address findings, and commit.

## Implementation phases

1. Establish the unchanged build, unit, browser and emulator regression baseline.
2. Extract pairing, encrypted relay sessions and ordered commands into a shared
   TypeScript client package. Keep browser persistence, rendering and direct
   transport adapters in the web app. Preserve public hosts and existing grants.
3. Add a CLI with its own named identity, both pairing directions, saved phones,
   status, screenshots, gestures, text, navigation, app launch and a persistent
   JSON-lines session. Keep secrets out of arguments and routine logs.
4. Add bounded accessibility snapshots and observation-bound node click, scroll
   and text. Redact password fields, expire references and revalidate targets.
   Advertise support additively so existing hosts remain usable.
5. Qualify the real CLI and existing browser against an owned emulator; retain
   meaningful regression coverage in CI and document exact evidence and limits.

ADB extensions, reboot redesign, MCP, video in the CLI and an autonomous planner
are outside this implementation. The existing screen-access permission and
phone-local access controls remain authoritative.

## Acceptance

- Both pairing directions, invitation expiry/cancellation, persisted identity,
  reconnect and independent client revocation.
- Screenshot and bounded UI snapshot; native effects for node click, targeted
  text, scroll, coordinate gestures, navigation and application launch.
- Refusal for stale observations, changed nodes, invalid coordinates, locked
  screens, protected local settings and missing accessibility permission.
- No replay after an uncertain delivery; bounded queues, cancellation and teardown.
- CLI pause/removal ends access while another paired browser remains usable.
- Existing browser pairing/storage, prepared connections, continuous touch,
  smooth video and direct/relay recovery remain covered.
- Existing public host capabilities and pairings retain their wire formats.

The CLI acceptance sends control through YepControl's encrypted transport without
a browser. ADB may provision the owned emulator and independently inspect fixture
effects; it must not deliver the CLI's target actions. Private logs, screenshots,
keys and grants stay in ignored `.local/` paths. Emulator qualification does not
establish physical-device, first-unlock, overnight or Play-policy acceptance.

## Evidence

### Baseline and shared client — 2026-10-30

The unchanged baseline passes 157 TypeScript tests, Kotlin protocol tests,
Android build/lint, public-site pairing and browser phone-management acceptance.
The first layout run timed out waiting for its permission overlay; the complete
five-size run passed after extraction. Installed JDK 17 must be selected explicitly
on this machine. The emulator requires DNS that resolves the development origin.

The original APK and built viewer pass owned API-35 emulator control: native
tap/text, held slider, long press, two-pointer gestures, watchdog release,
navigation, disarm/removal, smooth H.264 over direct WebRTC and direct-path loss
recovering to the relay without replay. This is the pre-extraction device baseline.

`client/` now owns pairing primitives, HTTP requests, encrypted relay sessions and
ordered command handling. Browser persistence and WebRTC remain adapters.
Development resolves shared source directly; production builds emit the package.
Vitest resolves shared source so local tests cannot silently use stale output.
The extraction passes 164 TypeScript tests, typecheck, build, TypeScript lint,
formatting and public-site, five-size layout and phone-management acceptance.

The requested Yep Anywhere Sol 6.1 High reviewer checked the extraction with
bypass permissions. Findings led to cancellation checks before/after lane
acquisition, abort-listener/timer cleanup, skipping absent WebRTC, development
source resolution and direct shared-source regression tests. No wire-format or
pairing-authority bypass was identified. Private reports and receipts remain in
`.local/cli-proof/`.

### CLI usage

After `pnpm build`, run `pnpm --silent yepcontrol pair --name 'My agent'` and
scan the terminal QR with YepControl. To claim a phone's **Show code** invitation,
pass its link through `pair --from-stdin`. `--code-file PATH` writes a private
terminal-issued link instead of printing a QR. Pairing uses the same explicit
phone approval and signed grants as the browser.

`phones` lists saved devices; select with `--phone ID` when more than one is
paired. `status`, `screenshot --out PATH`, `apps`, `wake`, `sleep`, `home`, `back`,
`recents` and `launch PACKAGE` are single commands. Screenshots give the scene
number required by `tap X Y --scene N` and
`swipe X Y END_X END_Y DURATION_MS --scene N`. Use `text --from-stdin` for text.
Artifacts refuse overwrite and use owner-only permissions. Identity/grants live
in `YEPCONTROL_HOME` or `~/.config/yepcontrol`, independently of browser storage.

Agents should use `session --stdio` to retain the encrypted connection. It emits
one JSON ready record, then accepts one JSON request per line, for example
`{"id":"s1","op":"status"}` or `{"id":"s2","op":"capture"}`. Each response
contains the caller's id, `ok`, and a reply or error. JPEG bytes are base64.
Requests execute sequentially and uncertain commands are never replayed.
A disconnected session must be reopened and observed before further input.

Results are JSON on stdout. With `--json`, fatal errors are JSON on stderr:
`{"ok":false,"error":{"code":"CLI_ERROR","message":"..."}}`, with exit 1.
Progress remains on stderr. Cancellation closes the connection; output and
shutdown flushing are bounded, including when the caller stops reading.
The CLI does not accept PINs, unlock, video or transport-negotiation commands.

### CLI process qualification — 2026-10-30

Retained tests run actual CLI subprocesses against a local HTTPS relay and a
cryptographic phone simulator for both pairing directions, persisted identity,
encrypted status, lost action replies without replay, cancellation and structured
failures. A process test fills stdout with a large screenshot, cancels without
reading it, and checks bounded exit and connection teardown. These tests do not
claim native input effects; emulator qualification follows in phase 5.

This phase passes 174 TypeScript tests, typecheck, build and TypeScript lint.
The requested independent Sol 6.1 High review is complete with no outstanding
findings after fixing blocked-output shutdown and structured fatal errors.

### Accessibility observation and actions

`snapshot` returns a bounded active-window tree (128 visited nodes, depth 20,
256-character labels) with password values redacted. In a persistent JSON-lines
session, send `{"id":"ui","op":"snapshot"}` and select a returned node by its
text/role/actions. Then send `nodeClick`, `nodeScroll` (direction `forward` or
`backward`) or `nodeText` with the returned `observation` token and numeric `node`.
For example: `{"id":"click","op":"nodeClick","observation":"...","node":7}`.
A single-command snapshot is useful for observation, but its references cannot be
used in another process/session. Use `session --stdio` for observation plus action.

References expire after 30 seconds, are consumed on an attempted action, and are
invalidated by accessibility content/window events, other remote input, local
settings changes and disconnect. The phone resolves the original path and checks
node identity, signature, visibility, enabled state and supported action before
acting. Obtain another snapshot after any refusal; there is no automatic retry.
Password nodes and their descendants are not actionable. Pairing, grant and PIN
pages remain phone-local and cannot be observed or controlled. General Settings
keeps its existing remote-access policy. Trees reflect what Android and the
foreground app expose, and may be incomplete; `truncated` reports traversal limits.

The optional `a11y: 1` capability and opcodes 20–23/reply 7 are additive. Existing
wire formats and pairing grants are unchanged. The CLI refuses semantic commands
without sending them to a public host that lacks the capability, preserving its
status/screenshot/gesture connection. No web UI redesign is required.

### Accessibility protocol qualification — 2026-10-30

The additive implementation passes 178 TypeScript tests, shared Kotlin command
vectors and malformed-target tests, Android build/lint, typecheck/build and
format checks. The independent Sol 6.1 High review led to a final live authority
and lock check after node resolution, refresh/password checks on every ancestor,
and private fingerprints of complete values (up to 4096 characters per field;
larger values cannot be acted on). Length-prefixed fingerprints detect changes
beyond truncated wire labels and include checked/selected state. A deterministic
blocked-resolution test verifies that losing authority prevents dispatch.

Public-site, all five layout sizes and browser phone-management checks pass.
The owned API-35 browser regression passes native input, held slider/long press,
multitouch, watchdog release, direct H.264 and direct loss recovering to relay
without replay. This run preceded the final semantic-only guard hardening; the
combined CLI/browser acceptance in phase 5 exercises the final build. An earlier
emulator attempt had an APK built for the default origin; rebuilding with the
explicit development `sharingWebsite` corrected the fixture setup.

The phase-4 reviewer rechecked all three fixes and reports no outstanding
findings. Native semantic mutation/refusal checks remain explicitly assigned to
the next phase.

## Repeating CLI/native acceptance

Build TypeScript with `pnpm build` and both debug APKs with
`./android/gradlew -p android :app:assembleDebug :app:assembleDebugAndroidTest
-PsharingWebsite=https://YOUR_DEVELOPMENT_ORIGIN` (select JDK 17). With that same
`HOSTED_ORIGIN`, run `pnpm test:cli`. This owns an API-35 emulator, provisions the
normal native permission/pairing UI, runs real built Node CLI processes and then
runs the existing browser control suite. It refuses physical selectors. Use
`HOSTED_TOUCH=1 HOSTED_VIDEO=1 HOSTED_DIRECT=1` for the full gesture/video/direct
regression. `HOSTED_DNS_SERVERS` must resolve the origin from the emulator.

The native fixture APK records independent button/text/scroll effects. New
fixture-only mutations change a label, change a text suffix beyond 256
characters, and mark a container as a password container. They are not production
control APIs. ADB sets up the fixture and reads those counters. Lock-refusal qualification
uses a temporary synthetic PIN on the owned emulator, cleared afterward with
shared fixture recovery; CLI target actions use only YepControl. Recovery also
handles interruption before PIN installation or after successful clearing. It
retains its marker on credential mismatch or failed keyguard restoration.
The CLI does not enter a PIN or unlock a secure keyguard.

CI retains actual CLI HTTPS/crypto subprocess tests and Kotlin guard/parser
regressions in its regular unit suite. The configured hosted-control CI jobs also
set `HOSTED_CLI=1`; native CLI acceptance is skipped when no development origin
is supplied, as with the existing hosted-control jobs. CLI native acceptance
requires an isolated origin without the experiment's proof-cookie gate.

Additional native resolver probes use a separate instance of the production
`SemanticAccess` class with the real active-window root. This test instance is
not subscribed to service events, so it retains an observation across a label,
text-suffix or password-ancestor mutation. The actual refreshed resolver must
refuse the changed target and leave native counters/values unchanged. A positive
control acts on the same real editable target. These are native resolver tests;
the separate CLI cases still send their actions through the encrypted session
and exercise normal service event invalidation. The probes do not qualify
transport or permission authority; those have separate tests.

Expected CLI exits have explicit acceptance deadlines. Teardown terminates and
awaits owned child processes, attempts grant cleanup and browser restoration,
and records restoration failures without replacing the original test failure.

### Final CLI/browser qualification — 2026-10-30

The combined owned API-35 run completed successfully with CLI, touch, video and
direct transport enabled. Real built CLI processes passed both pairing
directions, persisted identity, missing-permission refusal, native node click,
Unicode text and scroll, password redaction/value preservation, stale/changed/
expired/cross-session reference refusals, protected pairing-page refusal and
locked-screen refusal. Screenshot, coordinate gestures, navigation, launch and
independent client pause/removal also passed. Independent native resolver probes
passed suffix-change and password-ancestor refusal with a positive action
control. Synthetic-lock recovery passed normal and interrupted-marker cases;
cleanup removed the marker and reaped the owned emulator.

The same run then passed existing browser native input, held slider, long press,
multitouch, lost-packet watchdog release and direct-path loss recovering through
the relay without replay. Encrypted direct H.264 decoded 147 frames in 5.013
seconds. Global disarm and browser removal passed, with no page errors.

Final checks passed 185 TypeScript tests across 27 files, Kotlin protocol tests,
TypeScript typecheck/build/lint, Android build/lint and format checks. The
requested independent Sol 6.1 High review found and prompted stronger native
resolver probes, bounded child-process cleanup and idempotent synthetic-lock
recovery; all source findings were resolved. Private candidate hashes, detailed
receipts and review reports remain under ignored `.local/cli-proof/`.
The reviewer reconciled the completed CLI/browser run, candidate hashes and
cleanup receipts and closed phase 5 with no remaining actionable findings.

This qualifies the local emulator build, including the new Android capability.
Existing public hosts retain basic control but require an updated Android build
for semantic commands. Physical-device, reboot/first-unlock, overnight and
Play-installed acceptance were not part of this run; no release or deployment
was performed.
