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

## Next slice: unrestricted remote configuration

Owner decision, 2026-10-30. Implementation and release qualification are recorded
below. Allow an existing
browser controller to configure the phone and pair a separate CLI without a
phone-local approval step. Use one persistent phone-wide **Allow unrestricted
remote control** switch in ordinary Settings. No timer, browser bridge,
delegation protocol or separate pairing/PIN configuration tiers.

### Behavior

When enabled, all YepControl configuration pages are remotely viewable and
controllable, including Give control, grant approval, unlocking and saved-PIN
setup. Audit both input gates and app-owned capture restrictions so a hidden
pairing code does not leave adoption unusable. Android's own restrictions still
apply. This setting does not itself unlock the phone, change a PIN or enable
saved-PIN use; it allows the controller to operate those configuration screens.

When disabled, retain the existing protection of those pages. Ordinary Settings
remains remotely accessible, including this switch. Enabling remotely is an
intentional capability of an existing trusted controller. Before manual
enablement, explain that the controller can change unlock settings and add
controllers whose access lasts until removed. Show the current state in Settings.

Global remote-access state, per-device pause, revocation and existing unlock
permissions remain authoritative. Enabling unrestricted configuration never
reactivates paused/revoked clients or changes those permissions automatically.
The newly paired CLI has its own identity and can be removed independently.

### One-release upgrade rule

For the designated next Android release only, initialize the switch **on** for
an existing install with at least one saved, non-revoked pairing. A pairing need
not be connected or currently enabled. Here, “existing sessions” means saved
pairings, not live sockets. Fresh installs, installs with no pairings and
revoked-only installs initialize **off**.

Persist both the setting and a one-time initialization decision. Never repeat
the automatic enablement: an explicit off choice must survive reconnects,
process death, restarts and all later updates. Enabling during upgrade is
persistent; it does not automatically turn off at the following release.

Pin eligibility to an explicit release version code selected during release
preparation. An old install that skips this designated release and first runs
a later version initializes **off**. Do not use a permanent “old database means
on” migration or a check against whatever the current version happens to be.
The exception must not become an ongoing default for future installs/pairings.

### Implementation phases

Use three implementation phases. Each phase includes its relevant retained
tests and owned-emulator checks before independent review and commit.

1. **Persist and initialize.** Extend the Room settings schema compatibly with
   existing released databases. Keep structural migrations deterministic and
   make the release-specific eligibility decision in a transaction during
   `HostStore.load()`, after legacy pairing import and before publishing state
   or admitting commands. Record the decision for fresh installs before any
   new pairing can be created. Initialization must also work when the app wakes
   in the background; opening Settings is not required. Record an activity
   entry and show a nonblocking explanation for automatically enabled installs.
2. **Expose and enforce the switch.** Add the warning and persistent Settings
   control. Apply the choice consistently to protected-page input, snapshots,
   screenshots and video, including app-owned secure windows/dialogs. Refresh
   gates immediately when changed; invalidate old observations and handle
   in-flight input so disabling restores protection promptly. Preserve existing
   protocol/grants and the disabled-mode behavior.
3. **Qualify remote adoption.** Upgrade an owned emulator with a real existing
   browser pairing. Through that browser alone, open Give control, read the
   invitation and pair a real CLI using `pair --from-stdin`. Prove independent
   CLI control and removal, and rerun the existing browser regression suite.

After each implementation phase, use the requested Yep Anywhere API reviewer
(Sol 6.1 High, bypass permissions), resolve findings and commit. Follow the
existing owned-emulator/private-evidence discipline. Implementation acceptance
and actual release delivery are separate; this plan does not claim deployment
or Play-installed qualification.

### Emulator and physical verification

Owned emulators are sufficient to implement and qualify all three phases.
Phase 1 covers the upgrade/default/persistence matrix, including interrupted
initialization and skipped releases. Phase 2 verifies remote configuration,
capture and immediate restoration of protections. Phase 3 proves actual
browser-to-CLI adoption after an in-place upgrade, independent revocation and
the existing browser touch/video/direct-to-relay recovery regression suite.
Use synthetic credentials for unlock-configuration cases. Implementation does
not require physical PIN entry, physical reboot tests or debugging/lock-setting
changes on a real phone.

Before shipping, perform a small physical acceptance check through internal
Play on an already-paired phone. Update in place, preserving app data and its
existing pairing; do not uninstall/re-pair to make the check pass. Verify
automatic enablement, reconnect from the existing browser, obtain a pairing
code remotely, pair the CLI and exercise independent control/removal. Turn the
switch off and confirm protected-page input/capture restrictions return while
ordinary control remains usable. Record real-device accessibility/capture
behavior and actual installed-build evidence separately from emulator results.

This physical check validates release delivery and real-device behavior; it is
not a repeat of the full emulator campaign. Complete it before public promotion.

### Required acceptance

- Paired upgrade into the designated release initializes on, including an idle
  or paused pairing; fresh, unpaired and revoked-only installs initialize off.
- Direct upgrade from an older release to a later, ineligible release stays off.
- Explicit off survives process death, reopen and later updates; interrupted
  initialization cannot reset a completed choice or leave partially saved state.
- Enabled mode permits configuration and pairing-code capture through both
  browser and CLI; disabled mode restores all previous protected-page behavior.
- Global disarm, individual pause/removal and existing unlock permissions still
  work. Remote configuration does not itself grant credential-entry authority.
- Real browser-to-CLI adoption works without local phone interaction after the
  upgrade. Revoking the CLI leaves the browser usable, and vice versa.
- Existing pairing, ordinary control, continuous touch, video and direct/relay
  recovery remain covered; run schema/migration tests, build, lint and relevant
  unit suites. Use only synthetic credentials on owned emulators for PIN cases.

### Phase 1: storage and initialization — 2026-10-30

Android **0.10.0/code 11** is the designated upgrade release. Room version 4
adds default-off settings and a durable initialization marker without changing
pairing authority. `HostStore.load()` imports legacy grants and commits the
release-specific decision and activity event in one transaction before publishing
state. The normal application/background wake path uses this initialization;
opening Settings is not required. Eligible installations receive a persistent,
dismissible explanation. General settings edits preserve the new fields.

The owned API-35 emulator passes native navigation/protection and all 21 storage,
migration, enrollment and unlock-storage tests. Coverage includes paused paired
upgrades, fresh/unpaired/revoked-only installations, skipping code 11, explicit-off
persistence and a forced transaction interruption during legacy import. The
first-build test-asset dependency now packages the newly generated Room schema.
Android build/lint/format, 185 TypeScript tests and Kotlin protocol tests pass.
The requested Yep Anywhere Sol 6.1 High reviewer independently checked the
migration chain and initialization logic with bypass permissions and approved
phase 1 with no actionable findings. Enforcement and release evidence follow
separately; private review receipts remain in `.local/unrestricted-proof/`.

### Phase 2: Settings and input/capture enforcement — 2026-10-30

Settings now exposes **Allow unrestricted remote control**, its current state,
and a warning before manual enablement. The durable choice updates the common
protection gate synchronously on store publication, including background load;
UI/window refresh and held-input release run on the main thread. Existing
protocols, grants and per-device credential-entry permission are unchanged.

Sensitive pages retain their ownership while unrestricted mode is on, so turning
it off restores input/snapshot restrictions without requiring navigation. Pairing
and saved-PIN secure windows follow the choice. Disabling dismisses open PIN
configuration dialogs, invalidates observations and queued input, and refuses
capture completions from an earlier policy revision. Video offer/poll/configure
also check capture protection. Dialog ownership follows the parent lifecycle so
another foreground app remains controllable. PIN values remain redacted from
semantic snapshots and are never returned as saved credentials.

The owned API-35 native suite passes three tests covering existing disabled-mode
protection, remote manual enablement and its warning, remote synthetic saved-PIN
setup/removal, unchanged unlock permission, queued-input refusal, pairing-page
snapshot/screenshot access and immediate protection/secure-window restoration.
The 21 storage/migration tests also pass. The dedicated configuration test uses remote swipes to reach the new section
below existing Settings links and waits for Home before reopening the app.
Android build/lint, TypeScript typecheck/lint, all 185 TypeScript tests and the
public-site, all five viewer sizes and phone-management suites pass.

The requested independent Sol 6.1 High review found a snapshot-completion race
when policy changed during traversal. The shared semantic guard now revalidates
policy revision, service identity and lock state after building the tree; refusal
clears its observation before any tree is sent. A deterministic blocked-build
regression verifies discard/no reply, with an unchanged-policy positive control.
The reviewer rechecked the correction and reports no outstanding actionable
source findings. The final native/UI/storage rerun passes after that fix. Actual
upgrade/adoption and release delivery remain phase 3 and release acceptance.

### Repeating the in-place upgrade and remote adoption check

The control runner accepts `HOSTED_UPGRADE_APK_DIRECTORY` for the candidate's
`debug/` and `androidTest/debug/` APK directories. `HOSTED_APK_DIRECTORY` supplies
matching baseline APKs rebuilt from released source, with the same fixture
origin and local debug signer. This mode refuses physical selectors and runs
separately from `HOSTED_CLI=1` permission/refusal acceptance. It needs Tesseract
(`tesseract` on PATH, or `TESSERACT` pointing to its executable) for the received
phone-image labels; QR decoding uses the actual received browser/CLI pixels.

```sh
HOSTED_ORIGIN=https://YOUR_DEVELOPMENT_ORIGIN \
HOSTED_APK_DIRECTORY=/PATH/TO/BASELINE/apk \
HOSTED_UPGRADE_APK_DIRECTORY=/PATH/TO/CANDIDATE/apk \
HOSTED_TOUCH=1 HOSTED_VIDEO=1 HOSTED_DIRECT=1 \
pnpm test:hosted --control
```

The owned fixture pairs the baseline browser and grants normal screen access,
then updates both APKs in place without clearing data. Existing browser keys and
phone authority must reconnect. After upgrade, browser input opens Give control
and its received screen supplies the invitation to a real `pair --from-stdin`
process. The CLI independently controls apps, observes/captures configuration
and is removed through the browser. Relay HTTP 410 and a refused CLI reconnect
confirm removal while the browser stays connected. No phone-side invitation
export or local input delivers these adoption actions.

With video enabled, the runner additionally reads a configuration QR from live
video, disables unrestricted control remotely, and checks that protected-page
capture restrictions return while ordinary control remains usable. The existing gesture,
video and direct-to-relay recovery checks remain in the run. All evidence stays
private under the selected owned state directory. Repeating an upgrade fixture
restores its compatible candidate schema reader and revokes prior authority
before replacing that disposable baseline. This reset is restricted to the owned emulator; the
physical Play update must preserve its installation and baseline grant.

These APKs are fixture builds of released/candidate source, not Play delivery.
The separate internal Play-installed update is still required before promotion.

### Phase 3: upgrade, adoption and complete regression — 2026-10-30

An owned API-35 emulator, initially running a local fixture build of released
0.9.0/code-10 source, retained its actual browser grant through an in-place
0.10.0/code-11 update. The browser displayed the automatic-enablement notice,
reconnected and remotely opened Give control. The received browser image supplied
the QR to a real CLI process through stdin, without phone-side code export or
post-upgrade local approval. The CLI independently launched apps, observed and
captured configuration, then was removed through the original browser. The
relay confirmed HTTP 410, CLI reconnect refused, and the browser remained usable.

The same run decoded a configuration QR from real H.264 video frames, then used
browser input to disable unrestricted control. Protected-page input/capture
restrictions returned, while Back restored ordinary viewing/control. The full
browser campaign also passed native tap/text/scroll, held slider/long press,
multitouch, watchdog release, direct video and mid-input direct loss recovering
over the relay without replay. The acceptance runner targets received image
content and waits for visible postconditions, rather than treating input delivery
or a renderer frame counter as a completed UI transition.

A separate fresh-install CLI/browser run passed both pairing directions,
accessibility effects/refusals, independent client pause/removal, screenshots,
coordinate input, navigation, app launch, touch/video, rotation and direct/relay
recovery. Synthetic saved/manual unlock and failed-attempt recovery passed on
that owned emulator; no physical credential was entered. Both runs revoked
fixture authority, restored overrides and reaped their owned processes.

Native navigation/protection passes all three tests and the storage suite now
passes 22 tests. The additional file-backed test closes/reopens Room across later
version values, proving both persistent automatic-on and explicit-off choices,
notice dismissal and a single initialization event. Origin-comparison fixtures
now construct valid host/port variants when a development service uses a port.
Android build/lint, typecheck, 185 TypeScript tests, Kotlin protocol tests and
TypeScript lint pass. Private run/review evidence remains under
`.local/unrestricted-proof/`. Independent review and actual Play delivery are
recorded separately; emulator qualification does not establish physical or
Play-installed acceptance.

The third independent Sol 6.1 High review found one fixture-only stream-framing
issue. The new reader preserves UTF-8 across chunks and parses only complete
newline-delimited records. Retained tests use a real subprocess with split
Unicode/large replies and refuse truncated EOF. Both the implementation and
reviewer checks pass on pinned Node 24; the full TypeScript suite now has 187
passing tests. The reviewer rechecked the correction and approves phase 3 with
no outstanding actionable findings. Existing successful native/emulator evidence
is retained; this reader correction does not change Android behavior or claim
Play-installed acceptance.

The shared-runner release gate exposed the original security fixture reopening
MainActivity before its remote Home transition settled. It now observes the
launcher and a fresh Home status before opening pairing, matching the already
passing unrestricted-configuration case. This changes test sequencing only;
production Android input/capture policy and the deployed website are unchanged.

A subsequent Linux release run passed that Home sequence and timed out at the
synthetic PIN-save postcondition. The native fixture now waits for UI idle before
reading tap coordinates, observes each PIN field's focus before remote text,
and asserts both synthetic values before Save. This checks the actual input
effects without retrying remote commands. The corrected local suite passes all
three UI/security tests and 22 storage tests; Linux release acceptance remains
a separate gate.

Linux release run
[41140046532](https://github.com/kzahel/yepcontrol/actions/runs/41140046532)
passes the corrected native UI/storage suite and hosted process-absent FCM wake.
The following mobile-management harness stopped on its obsolete six-test count:
`HostStoreTest` now reports eleven passing tests. Its exact-count assertion is
updated to eleven; no test is skipped or acceptance assertion relaxed.

A following run exposed a separate coordinate race in the original protected-mode
local positive control: after seeding matching synthetic fields, its Save tap
left field lengths of seven and six. That fixture now invokes the real dialog
Save/Forget buttons on the main thread, retaining their listeners and durable
effects. It does not call storage directly. The unrestricted-mode case retains
actual remote taps/text and the focus/value assertions; protected-mode remote
refusals remain in place.

The next Linux run passes native UI/storage, hosted FCM and both QR directions,
then reaches the CLI's immediate launcher assertion after remote Home. That
fixture now requires the Home result to succeed and polls the existing bounded
activity-state condition, matching its following launch check. The Home command
is sent once; an accepted navigation request does not imply the activity
transition has already completed.

### Play-installed physical acceptance — 2026-10-31

Android 0.10.0/code 11 passes an in-place internal Play update on the paired
Pixel 7a, retaining the original browser authority and showing the automatic
enablement explanation. Browser-only code capture adopts a real independent CLI;
its own app control and configuration-QR capture pass. The original browser
removes it, with relay revocation and refused CLI reconnect verified. Actual
video exposes the configuration code while enabled. Remote disable restores
protected-page input/capture restrictions, and ordinary control remains useful.
The setting is restored on through the browser warning. Full receipts and
physical limits are recorded in the
[Android beta record](distribution/android-beta.md#android-0100--code-11--2026-10-31).

The physical dynamic palette requires standard-layout OCR alongside sparse OCR
and saturated-button crops that exclude tinted page surfaces. Saved physical
Home/Give-control images and a retained emulator Home image pass focused image
probes. The fixture driver obtains a fresh observation after native semantic
code 2 only, capped at three total attempts, recording each refusal; accepted
or uncertain actions are not replayed. Independent review verifies the pre-action
contract and bounded failure branches. A moving layout later required manual
browser continuation for the physical removal/protection check; this does not
claim that the full generic image-driver run completed automatically on the phone.
