# On-demand advanced control

Owner authorization, 2026-11-01: implement the proposed manual remote arming flow
in the live app, verify it on the attached Moto, commit/push the work, deliver an
internal Play build for installed acceptance, then publish the accepted artifact
to production at 100%. Existing pairings, ordinary control and access switches
must survive the update. Submission, Google approval and availability are
separate outcomes.

## Release scope

Settings → Advanced control is optional and initially off. Initial phone-only
setup uses Android Developer options / Wireless debugging and a notification
pairing-code reply. No computer, on-phone Linux environment or separate ADB app
is required. Setup retains the paired identity and grants this app the limited
settings permission needed to request Wireless debugging later. That permission
is separate from the policy: this version never arms advanced control at boot.

Once setup is paired, the Start/Stop page accepts ordinary remote control even
when configuration protection is on. Pairing/developer options/forgetting live
in protected setup. A controller opens the control page and presses Start.
Android may request approval for the current Wi-Fi network; ordinary remote
control must remain usable for that approval. Stop returns to ordinary control.
No automatic approval handler is included. No first secure unlock guarantee is
made. Expired/revoked Android pairing must result in a visible repair action.

Input uses the advanced helper only when explicitly started and authenticated,
after the existing controller, keyguard, scene and local-settings checks.
Never replay an input on a second route after an ambiguous result. No arbitrary
shell operation is exposed to controllers. Secrets stay in backup-excluded,
credential-encrypted application storage; the ADB identity is protected by an
Android Keystore wrapping key. Helper bootstrap uses OS-authenticated shell UID,
a fresh capability and a short renewable lease. Stop/process death/reboot must
invalidate readiness. Native crypto and dependency notices must be reviewed.

## Verification and delivery

1. Harden and integrate the embedded client, pairing UX and on-demand lifecycle.
2. Exercise input against a protected fixture on an owned modern emulator;
   verify default-off, Stop, revocation, process death and reboot behavior.
3. Verify the real ordinary viewer/CLI can press Start on the unlocked Moto
   with advanced control initially unavailable, and Android Allow when Android
   presents that dialog. Record an already-trusted network separately from
   approval-dialog coverage; never reset unrelated debugging trust to force it.
   USB observation
   is permitted; USB input or privileged test automation cannot count as that
   acceptance. Record precise device/Android limits privately.
4. Run relevant existing lint/tests/builds and compatibility checks. Review the
   final security boundaries and component licenses before signing.
5. Publish to internal Play via existing CI; accept an in-place Play-installed
   update on the paired Moto. Promote that exact artifact to production, 100%,
   preserving country selection, then record review/publication state.

Evidence and private selectors belong under ignored `.local/advanced-control/`.
Progress and limitations will be appended here as the implementation is tested.

## Candidate 0.12.0 / code 14 — local verification, 2026-11-01

Implemented the separate native Advanced control page, explicit Start/Stop,
phone-only notification pairing, encrypted identity, restricted authenticated
shell helper and raw single/multiple-contact input. No boot receiver or automatic
approval handler was added. Generic CLI UI actions can operate the same page;
there is no separate shell command exposed to controllers. Readiness adds only
three optional booleans to the existing state envelope. Semantic tree/text and
secure-screen capture still use their existing Android routes and restrictions.

The owned Android 16 / API 36 arm64 acceptance passes with the production host
code: initially off, notification consent, native Android pairing code, phone-local
permission grant, shell-UID attestation with non-shell rejection, input that
increments a native sensitive-view counter, wrapped identity at rest, Stop
without losing pairing and reboot without advanced arming. Extended checks
verify two held contacts expire with cancellation rather than a click, stale
continuation is refused, fresh input recovers, the stopped helper endpoint closes,
and paired runtime controls remain reachable while setup stays protected. No desktop ADB pair
or privileged grant bootstrapped this setup. The primitive's two peers agree on
a fresh pairing key and reject context reuse. The harness owns/reaps its emulator
and is included in the release smoke workflow, which uses x86_64 for CI coverage.

The app and release bundle build, Android debug/release lint, Kotlin formatting,
protocol JVM tests, TypeScript build/typecheck and 226 TypeScript tests pass.
The protocol boundary test covers old-host absence, malformed readiness and the
2048-byte released state envelope with maximal device fields and live media.
The release runtime graph excludes spake2-java/spake2-android. All distributed
64-bit native libraries have at least 16 KiB ELF LOAD alignment. See
[component and authority review](advanced-control-components.md) for pins,
notices and the bounded pairing changes.

The Moto baseline is Play-installed 0.9.0/code 10, Android 12/API 31, with Wireless
debugging off. Its private baseline is retained before the in-place update.
Real ordinary-channel Start/Allow, protected input through the product session,
installed Play acceptance and production promotion are still release gates;
the native fixture above does not establish those outcomes.


### Start/Stop generation hardening

Review found a late-start race: work completing after Stop or replacement could
publish readiness into a new service lifetime. Bootstrap, readiness, pairing
completion and identity writes are now guarded by the exact Start generation.
Stop cancels that generation immediately; stale completion cannot install a
capability, mark a replacement Ready or recreate a forgotten identity. Native
status updates run on main with the same generation check. Unchanged status
polls preserve the existing controls rather than rebuilding the page repeatedly.
A deterministic native regression covers cancellation and replacement ordering;
local Android 16 acceptance passes with this hardening.

The first release CI attempt stops at the phone-only setup test before signing
or Play upload. Its private UI evidence was deliberately not uploaded; the
harness now emits a redacted failure reason so the CI-specific failure can be
resolved. This run is not an accepted store candidate. The companion website
release `relay-v0.5.2` deployed successfully from the initially checked source;
its only runtime change is optional advanced readiness decoding and it remains
compatible with older hosts. Android signing/installed acceptance remain pending.


### Pointer compatibility and CI navigation

Raw input now maps protocol contact IDs (up to 1,000,000) to Android's bounded
pointer slots. It preserves the existing ten-contact / 24-sample protocol limits.
The owned acceptance uses all ten high-ID contacts and 24 samples, verifies
cancellation without a click, rejects stale continuation and accepts fresh input.
The test now waits for loaded Settings and resolves a live accessibility node
for idempotent page navigation, avoiding scrolling/rendering races in CI.
Local acceptance passes. Existing sensor and video teardown remains ahead of
advanced-helper shutdown so optional setup cannot delay their disconnection.


### Presented-fixture precondition

The CI run now pairs and authenticates successfully, but its first raw tap did
not increment the fixture counter. The owned test now waits for the fixture's
focused window and committed frame before injection, rather than treating a
layout callback as presentation. It records only synthetic fixture event/focus
metadata on failure. This distinguishes missed presentation from input filtering;
no raw input is retried after an ambiguous result. Signing remains gated on the
complete test passing in CI.

Local Android 16 acceptance passes with these presentation checks. Test navigation
also retains `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES` consistently when
reading live accessibility nodes, so UiAutomation does not reconfigure the
connection and suppress the ordinary service during setup. CI qualification and
Play-installed acceptance remain pending.

The next CI attempt stopped earlier: the notification permission button was
found, but its coordinate click did not produce the grant. Initial owned setup
now resolves that native button from the current focused permission-controller
window and requires Android to accept its semantic click. This is limited to
initial local setup; helper input and product-channel remote recovery remain
separate acceptance requirements. No failed attempt was signed or uploaded.

The local rerun passes the full acceptance after allowing the Google permission
controller package with its Android resource-ID namespace. The superseded CI
run was cancelled before signing; the final candidate still requires CI and
Play-installed Moto acceptance.

### Abrupt process-death qualification

Local Android 16 acceptance also starts a fresh authenticated helper after Stop,
abruptly force-stops the app, and verifies both the attested helper process and
its live endpoint disappear within the lease deadline. Repeated unauthenticated
challenge probes cannot keep it alive. Reopening the normal app does not re-arm
advanced control; the subsequent owned reboot still passes. No helper capability
or identity leaves the phone for this check.

CI now completes notification consent. Its next failure was a missing Build
number node between the fixed seven taps. Native setup now resolves a fresh row
for every tap and finishes when Android reports Developer options enabled,
rather than assuming every coordinate tap was delivered. Local full acceptance
passes with this change. The earlier CI attempts remain unaccepted and uploaded
no Android artifact to Play.

### Native approval transition

Redacted CI evidence identified SystemUI's Wireless debugging network approval
dialog still in front of Settings when the harness looked for the pairing row.
Initial owned setup now resolves the native `android:id/alwaysUse` and positive
button within SystemUI, and waits for an enabled pairing row. It does not rely
on the approval text appearing within three seconds. Local full acceptance,
including abrupt process death and reboot, passes with this change. This
initial-setup harness is not product-channel remote-approval acceptance.

The app's recovery instructions now explicitly state that Android may block
remote approval and require approval on the phone. The required ordinary-channel
Moto Start/Allow check must establish its measured support; this is not a
universal promise for all Android/OEM versions. Kotlin checks and debug/release
lint pass after the copy change.

### Packaging and emulator-system review

The merged-artifact review caught implicit phone-state/storage permissions from
the ADB library's missing target SDK. All three are explicitly removed and a
release-manifest verifier now gates signing. The local release bundle, merge and
lint pass; actual-manifest mutations confirm the legacy permissions are rejected.

The next redacted CI failure showed Android's ANR dialog (`android:id/aerr_*`)
covering the resumed Developer-options activity. It did not establish a helper
input defect. The owned harness is moving from deprecated `swiftshader_indirect`
to the documented SwiftShader GLES path with Vulkan disabled, uses zero-duration
test animations, and releases CI build-daemon memory before boot. These are
environment controls to evaluate, not a confirmed explanation of every previous
failure. Safe ANR process/frame diagnostics are retained on future failures.
See [Android graphics acceleration](https://developer.android.com/studio/run/emulator-acceleration)
and [emulator troubleshooting](https://developer.android.com/studio/run/emulator-troubleshooting).
CI and Play-installed acceptance remain required; no code-14 upload has occurred.

The complete local suite passes with these environment controls and the cleaned
manifest, including protected input, crash expiry and no restart/reboot arming.
The release bundle builds and its merged-manifest gate passes. Linux CI must
still confirm this candidate before internal delivery.

### Cross-suite CI progress

On source `39437580df7ea7016eab12ef5c1be732cdcb10f7`, full Checks and the
Linux/x86 Android-16 advanced suite pass, including phone-only setup, protected
input, Stop, crash expiry and no reboot arming. Interoperability, native/mobile
media and hosted process-absent FCM wake also pass. The release job then stopped
at an older phone-first browser assertion that searched for Disconnect while
the portrait layout keeps it inside More controls. No signing/upload occurred.

That acceptance now opens the actual More controls menu first. Its complete
local hosted run passes phone-first automatic connection, secure QR hiding,
cancelled-code refusal, preserved browser-first pairing, both encrypted browser
checks and cleanup. The updated full release run is still required.

The repeat native CI reached the final reboot after completing setup/input/Stop
and process-death checks, then its `adb reboot` client timed out while that
transport was being torn down. The harness now tolerates only the command's
transport timeout/disconnect and independently requires an increased Android
boot counter plus completed boot. No command retry or shared-server reset is
performed; no new boot still fails qualification.

### TLS identity and final regression

Review of the exact AAR bytecode found a singleton client TLS context retaining
its first key manager. The connection-owner adapter now publishes a fresh
context with the current identity and fresh session caches; local Forget
replaces it with an unkeyed context. Both publications occur under the existing
Start-generation/Store guard. The [component review](advanced-control-components.md#tls-identity-ownership)
records the pinned private-field integration and its scope.

Ready alone did not distinguish old-cache behavior. The same-process re-pair
regression therefore observes the client certificate after a real ADB STLS
upgrade and fresh TLS handshake, comparing it to the new stored public key.
The complete local suite passes this wire check, plus protected input, Stop,
crash expiry and no restart/reboot arming. The local full control/media/video
run and all 226 TypeScript tests pass. Release lint, the bundle and merged
permission/component gates also pass.

The previous full CI reached CLI acceptance but stopped when its coordinate
setup did not produce a protected Show code view. CLI security fixtures now
activate that actual button once semantically; the separate phone-first UI
suite retains its normal touch path. Future failures expose only a fixed
phone-code phase enum and input-in-flight boolean, never QR content. The focused
local real-CLI run passes both pairing directions, protected-page refusals and
independent revocation with this setup. CI/Play-installed qualification remains
pending; no code-14 upload has occurred.

The negative control removes only the TLS bind/forget calls and fails the
real-wire certificate assertion with “ADB TLS reused a forgotten identity.”
Restoring them passes the complete suite; this establishes that the regression
detects the credential bug rather than readiness alone.

### Complete CI and internal-delivery reconciliation

Exact app source `b7473f0e946f6a9d858f6872d824c8f2fc495789` passes
[Checks](https://github.com/kzahel/yepcontrol/actions/runs/41354473148), CodeQL,
and the entire [Android release run](https://github.com/kzahel/yepcontrol/actions/runs/41354475580).
This includes the Linux/x86 native advanced suite, interoperability, native
control/media, hosted process-absent FCM wake, both QR directions, actual CLI
security/effects, encrypted viewer control, video and sensor cleanup. Release
lint and the merged-manifest gate pass before CI signing.

The signed 0.12.0/code-14 bundle SHA-256 is
`39f449794070cb336bbb31d2fa3d9941ae32f090582d7dfc3814882fb305d65f`.
Its downloaded source/version/checksum receipt and JAR signature verify locally.
The public [review demonstration](https://github.com/kzahel/yepcontrol/releases/tag/play-review-v0.12.0)
retains the earlier remote-session recording and appends an owned-emulator
native Start/Ready/notification-Stop recording. It does not substitute for
product-channel remote recovery or Play-installed Moto acceptance.

Internal API upload/validation succeed, but commit rejects the review-deferral
parameter with `INVALID_ARGUMENT`; fixed-label diagnostics expose this without
logging arbitrary Google response bodies. Withdrawing the prior code-13 review
alone did not resolve it. The production code-13 release remains staged and
must be resubmitted. Google's [commit reference](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit)
explains that review submission is app-wide; the default publisher still refuses
to cancel a review or submit unrelated staged changes.

An explicit one-time recovery is restricted to this exact CI source, run and
bundle checksum, an existing edit with internal 14 and already-accepted
production 13, and no other track releases. It revalidates unchanged tracks,
performs no upload or track write, and requests review without cancelling an
active review. This restores the code-13 submission while committing only the
already-staged internal-14 candidate. Eighteen publication regressions pass,
including refusal of mismatched bytes, another production version and other
tracks. Recovery outcome and Play-installed acceptance remain pending.

The bounded [reconciliation run](https://github.com/kzahel/yepcontrol/actions/runs/41359216774)
succeeds with the same signed bundle checksum. Console confirms 0.12.0/code 14
**Available to internal testers**, with 178 countries/regions retained. The
previous 0.11.1 full production rollout and store changes are again **in review**;
code 14 has not been promoted to production. The one-time recovery entry point
and workflow input are removed immediately afterward. The normal internal-only
publisher and its review-cancellation guard remain, with the safe error labels.

The initial pre-update Moto inspection reports Play-installed 0.9.0/code 10.
The actual encrypted CLI continues to connect and capture, including ordinary
Back navigation. Its native Store listing shows the public release notes;
internal-test enrollment redirects Chrome to Google's signed-out account
chooser. The enrollment page initially appeared to need owner sign-in. The
account-reuse flow and installed acceptance below supersede that apparent blocker.

### Play-installed Moto acceptance — 2026-11-02

Chrome's native sign-in sheet can reuse the account already present in Android.
Continuing with that existing account, declining history/tab sync and accepting
the internal-testing invitation made the candidate available in the native Play
Store. No password, PIN or new Android account was needed. Chrome was signed
out again after the update, without clearing browsing data.

The Moto g power (2022), Android 12/API 31, updates in place through Google Play
from **0.9.0/code 10 to 0.12.0/code 14**. The installer is
`com.android.vending`; the original install time and APK signing certificate
match the private baseline. The existing controller reconnects without pairing
again, and the original browser remains present. Unrestricted remote control,
camera and microphone remain off. Advanced control initially reports unpaired
and off, with no helper service.

Initial native setup enables Wireless debugging, pairs using the phone's own
code and notification reply, and self-grants the limited settings permission.
No desktop ADB pairing or permission grant is used. The actual helper runs as
Android's shell user. The temporary native setup driver is then removed; the
older spike's automatic approval adapter is verified disabled throughout.

Using the actual encrypted CLI session, ordinary control stops advanced input,
disables Wireless debugging through Settings and returns to the paired runtime
page. Read-only USB observation confirms the listener is off and the helper
absent. An ordinary remote raw tap on **Start advanced control** then reaches
**Ready**, with unrestricted control still off and no USB input. The runtime
page remains accessible while **Setup and pairing** refuses remote capture.

With advanced input ready, a real raw tap increments an independently observed
native fixture counter. An 850 ms held gesture starts Android's native drag,
and a 600 ms raw swipe visibly scrolls the app's Settings page. Real raw taps
also open Google Maps' profile menu, Settings and App & display, without changing
Maps preferences. Stopping advanced control removes readiness and a further
ordinary raw tap increments the same fixture counter again.

The current Wi-Fi network was already trusted by Android, so neither initial
setup nor manual recovery shows a fresh **Allow wireless debugging** dialog.
Its ordinary-product approval path is **not newly qualified** by this run.
Android refuses a diagnostic explicit launch of that unexported SystemUI
activity; no privilege bypass, trust reset or physical reboot is used to force
it. Earlier [spike accessibility evidence](local-adb-phone-spike.md) is separate
from this release's real product-channel evidence. The product and store copy
retain the possible on-phone approval limitation. API 31 also predates the
sensitive-view flag: Maps navigation here is not an A/B reproduction of the
original newer-phone restriction. The protected-view input regression is
covered on the owned API 36 emulator.

Cleanup removes only the temporary controller through the real app UI; the CLI
then reports authoritative removal. The original browser remains. Advanced
control and Wireless debugging are off, both helper processes are absent, sensor
services are idle and media projection is null. The newly paired advanced
identity/settings permission are intentionally retained for later manual Start.
No physical lock credential, reboot or unrelated phone setting changes occur.
This qualifies manual recovery on the tested trusted network, not physical
reboot, new-network approval or universal protected-screen access.
