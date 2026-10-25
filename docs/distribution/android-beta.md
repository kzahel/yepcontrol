# Android beta distribution

Owner-authorized 2026-10-21. Initial settings: **YepControl – Remote Phone**,
`com.yepcontrol.app`, Tools, English (US), free installation, no ads, no required
account, intended audience 13–15 / 16–17 / 18+. Content rating is assigned from
the truthful utility questionnaire, separately from intended audience.
The first track is internal testing. Verify the Play-installed build on the
owned test phone before expanding to a closed beta. This initial scope did not authorize production rollout; later
publication authorization and releases are in the
[production record](android-production.md).

Store copy is in [listing.en-US.txt](listing.en-US.txt), editable artwork in
[artwork](../../artwork/README.md), and the privacy URL is
`https://yepcontrol.com/privacy/`. E2E content is separate from retained
connection metadata and Firebase installation identifiers; never claim the
service collects no data whatsoever. Play AccessibilityService and foreground
service declarations must match the APK and include the required review demo.

## Accessibility disclosure and review preparation — 2026-10-21

Source-reviewed against Google's [accessibility declaration requirements](https://support.google.com/googleplay/android-developer/answer/10964491?hl=en),
[disclosure guidance](https://support.google.com/googleplay/android-developer/answer/11150561?hl=en)
and [User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en).
These are documented requirements and implementation observations, not a Google
approval verdict.

The app already presents a separate disclosure before opening Android's
accessibility settings. First-pair setup exposes screen access, Cancel leaves it
disabled, and the user can return later. The revised dialog uses ordinary
language, warns that other apps may show private information, explains encrypted
sharing with approved browsers and how to stop access, and uses **Agree and
continue** for the affirmative action. PIN storage/unlocking and background
connections retain their separate opt-ins. Declining may leave viewing and
control unavailable; no alternate remote-control functionality is required.

Google requires an explanation of the access, purpose and sharing, not the
literal class name `AccessibilityService API` in the end-user dialog. Keep that
technical identification in the declaration and existing store copy. The
service correctly does not declare `isAccessibilityTool`. A separate stored
in-app agreement flag is possible hardening, not a prescribed implementation
or a confirmed compliance defect merely because it is absent.

Before review, verify the live Console declaration and attach an accessible demo
video showing app launch, the complete disclosure, refusal and reopening,
agreement, Android's permission grant and actual browser-driven viewing/input.
Explain the accessibility screenshot/input capabilities, separate MediaProjection
video and optional owner-requested PIN entry. Review the PIN capability against
the [sensitive API policy](https://support.google.com/googleplay/android-developer/answer/16558241?hl=en);
disclosure does not itself establish policy acceptance. Reconcile the declaration
with the privacy policy and documented E2E Data safety treatment. The earlier
Console setup record does not establish that the accessibility form/video has
been completed.

The revised flow passes an owned Android 15/API-35 emulator recording against
the live website in isolated Chromium: app opening, normal pairing approval,
the complete disclosure, Cancel with screen access still disabled, a browser
connection showing the missing screen permission, reopening/agreement, the
normal Android accessibility grant, actual screen viewing, browser-driven
Home/Recents and Settings launch, and disconnect. The side-by-side captioned
MP4 and private receipt remain in ignored `.local/accessibility-review/`.
The temporary pairing was revoked and the browser/emulator processes reaped.
This is debug-candidate evidence, not Play-installed acceptance or Google review;
it does not demonstrate PIN entry or smooth-video permission.

Uploaded 2026-10-22 as a public attachment in
[GitHub issue #1](https://github.com/kzahel/yepcontrol/issues/1).
[Direct MP4](https://github.com/user-attachments/assets/f9155903-2f09-430d-a508-e5631a071ff9).
Both the issue and video are accessible without signing in; an anonymous download
matches the local recording byte for byte. The video remains outside Git history.
It has not been attached to a Console declaration.

## CI and signing

Ordinary push/PR **Checks** builds/tests/lints TypeScript and Kotlin, builds the
debug app and instrumentation, tests the preserved spike and release publisher,
and scans full Git history for secrets. It receives no signing or Play secrets.
Third-party actions are pinned to immutable commits. Android setup uses the
current v4 action rather than the old v3 default that installs removed SDK tools.

`android/version.properties` owns the version. Increment its code for each new
Play bundle; never reuse a consumed code for changed bytes. On clean `main`:

1. Commit/push the candidate; wait for **Checks** to pass for that exact source.
2. Dispatch **Android release artifacts** (`android-release.yml`) on `main`.
3. The build job checks exact-source CI and builds/lints the actual release AAB
   without credentials, after the reusable owned-emulator crypto/navigation/storage
   smoke suite and hosted pairing/FCM/ordinary-control acceptance pass for the same source.
   The repository variable `HOSTED_ACCEPTANCE_ORIGIN` designates the HTTPS development
   relay; release builds fail if it is unset. The matching viewer must already be
   deployed there. These tests own synthetic emulator pairings and never select a
   physical phone. CI's ephemeral debug signing key is not domain-associated:
   `HOSTED_VERIFY_APP_LINKS=0` excludes OS association verification there, while
   the decoded invitation enters the explicit native activity and normal Grant
   still runs. Native origin validation remains required. Verify OS App Links
   separately with an associated debug or Play-installed signer.
   CI covers viewing, input, H.264 and rotation. Software video and held gestures
   run in sequence; concurrent performance and credential/reboot qualification
   stay separate (see `docs/control-acceptance.md` for the Linux fixture limits).
   A separate main-only `android-release`
   environment signs the exact unsigned artifact using a dedicated project upload key.
4. Download `yepcontrol-play-CODE`: it contains the signed AAB, its public upload
   certificate, SHA-256 and source/version/run receipt. The private key is
   removed from the runner and never included in the artifact.
5. The first app/bundle and declarations need Play Console setup. Google Play
   App Signing owns the final install signer. Add its SHA-256 certificate to
   `/.well-known/assetlinks.json`; the upload key is a different identity.
6. Dispatch **Android Play beta publication** (`android-publish.yml`) on `main`
   with that build run ID, English release notes and status `check`, then
   `draft` or `completed` as appropriate. It consumes the already signed bytes;
   it does not rebuild or accept an arbitrary source SHA/version.

The publisher verifies the successful main-only build workflow, source ancestry,
tracked version, exact-source passing Checks, artifact receipt and checksum
before Google authentication. It uses transactional Play edits; mismatched
bytes, downgrades, unrelated drafts and active rollouts fail. It validates
before commit and does not retry an ambiguous commit. A submitted receipt
means API acceptance; verify actual Play availability separately.

The initial publisher accepts **internal only**, with no production route.
Changing branch code alone or pushing a tag never publishes to Play.

## Configuration contract

Private signing/IAM resources, backups and tester contacts live in the owner's
private operational inventory. The public contract contains no operator paths,
cloud account IDs, service-account credentials or tester emails.

- Main-only environment `android-release`: secrets
  `ANDROID_UPLOAD_KEYSTORE_BASE64`, `ANDROID_UPLOAD_PASSWORD` (PKCS#12, alias
  `upload`, same store/key password). Provision through stdin without logging.
- Main-only environment `android-play-beta`: variables
  `ANDROID_PLAY_WIF_PROVIDER`, `ANDROID_PLAY_SERVICE_ACCOUNT`.
- Google Workload Identity Federation must bind the immutable repository/owner
  IDs, exact main ref, exact `android-publish.yml@refs/heads/main` workflow and
  exact `android-play-beta` environment subject. Read the repository's actual
  OIDC subject customization; immutable subjects differ from older examples.
- A dedicated service account receives only app-scoped Play information/testing
  release access. No unrelated app, financial, account administration or
  production-release permission, broad Google project role or JSON key.
- Google IAM/STS/IAM Credentials and Android Publisher APIs must be enabled.

The signing and transactional publisher adapt the owner's MIT-licensed
[Babytrack implementation](https://github.com/kzahel/babytrack), with YepControl's
package, native-library verification, version contract and beta-only authority.

## Qualification status

Local release AAB building/lint and strict upload signature verification pass.
Publisher regressions cover source/workflow mismatch, corruption, stale drafts,
downgrade, production refusal, validation failure and unknown commit outcome.
Live CI signing, Play access, listing setup and actual beta availability must be
recorded below when verified; this document alone does not establish publication.


## CI candidate receipt — 2026-10-21

Source `23da3af464dd5724e1a6ba35e3d89b39a5e3d415` passes full
[Checks 39648064549](https://github.com/kzahel/yepcontrol/actions/runs/39648064549).
[Release artifacts 39648579086](https://github.com/kzahel/yepcontrol/actions/runs/39648579086)
then builds and signs **0.6.0 / code 4** successfully. The downloaded artifact's
receipt, checksum and strict JDK signature match the exact source/run/version
and dedicated upload certificate. AAB SHA-256:
`a8b81e12c87cac911b8f546acd7dbb571d46dbdb4416722b39ca75b3fd21c6e7`.
Both 64-bit WebRTC ELF ABIs have load-segment alignment of at least 16 KiB;
the two 32-bit ABIs have 4 KiB alignment. This is a binary inspection, not a
claim of testing on a 16 KiB device or Play's server-side acceptance.

The physical Pixel 7a (API 37) passes public QR/Grant pairing, encrypted reconnect,
process-absent real FCM and revocation with the new app identity. A separate
ordinary-control run passes viewing, input/text/navigation/app launch, H.264,
quality changes, held dragging, long press, pinch/rotation gestures, native
WebRTC and mid-drag direct loss with encrypted relay recovery/no replay. No
physical PIN, reboot, Doze or lock/debugging changes are involved. Owned test
packages are removed afterward. This is debug-build device evidence; it is
separate from verification of an actual Play-installed release.
The runner selectors now match the native management test's renamed method.

The live privacy page and native navigation/theme suite pass.

## Internal publication — 2026-10-21

After the owner confirmed the policy/export declarations, the app was created
and the dedicated publisher received only app-scoped information and testing
release permissions. [CI access check](https://github.com/kzahel/yepcontrol/actions/runs/39654919172)
passes through short-lived WIF authentication.
[CI publication](https://github.com/kzahel/yepcontrol/actions/runs/39655110481)
then submitted the exact signed code-4 bytes above to **internal testing**.
Play Console confirms **Active / Available to internal testers**, version 0.6.0.
The tester list is invitation-only; contacts and the enrollment link are kept in
the private operational inventory. Accept the invitation with the phone's Google
account, then open the Play listing. No production rollout was performed.

This release is **not reviewed by Google** and initially appears as
`com.yepcontrol.app (unreviewed)`. Store listing and policy setup are separate
from internal availability. The website association now includes all three
Play signing fingerprints copied from Console, while retaining the development
certificate for owned fixtures. Play-installed device acceptance remains pending;
the successful debug-build tests above do not establish it.


### Store setup and review state

All eleven initial Console setup tasks are completed: Tools category, public
support email/website, privacy policy, reviewer QR/second-device instructions,
no ads, ages 13–15 / 16–17 / 18+, Data safety, and no government, financial or
health features. Store copy, the 512-square icon, 1024 × 500 feature graphic and
three unmodified 1080 × 1920 native screenshots are saved. Screenshot order is
Home, Settings, Appearance. The owned emulator navigation/theme suite passes at
this 9:16 display size; it is reaped after capture.

The owner separately accepted IARC terms. Its questionnaire assigns ESRB
**Everyone**, **PEGI 3**, USK/ClassInd all ages and generic 3+, with **Users
Interact**. This content rating is distinct from the 13+ intended audience.
Paired screen sharing is disclosed, with blocking/revocation and invited-only
interaction; the app has no public content feed or content catalog.

Data safety declares collected device/other IDs for functionality and security:
required pairing identities and optional Firebase installation delivery IDs,
retained rather than processed only ephemerally. Transport is encrypted; there
are no accounts. The policy provides deletion-request steps and explains the
security records retained without a fixed expiry. E2E screen/control contents
are excluded under the [Play definition](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en);
Firebase processing follows its [Android SDK disclosure](https://firebase.google.com/docs/android/play-data-disclosure).
Transfers to service providers are distinguished from third-party sharing.

The icon and feature graphic are labeled as AI-assisted artwork in Console;
the actual app screenshots are not generated or edited images. See
[Play's asset declaration guidance](https://support.google.com/googleplay/android-developer/answer/17262077?hl=en).

**These listing/policy changes are saved, not Google-reviewed or published.**
Console still gates review on a closed-test release. The internal release remains
active and unreviewed; no closed or production release was created. The owner
account accepted the internal tester invitation. Its Play listing opens, but the
browser Install flow stalls before device selection. A read-only check confirms
the test phone does not have `com.yepcontrol.app` installed, so Play-installed
acceptance remains pending. Complete that check before expanding the beta.


## Cloudflare-compatible internal update — 2026-10-22

**0.7.0 / code 5** is Active / Available to internal testers in Play Console,
released Oct 22 at 22:18 CEST. It supports the Cloudflare relay's routed sockets
and bounded ciphertext receipts while retaining the Node/local relay option.
Update older installed hosts before connecting through Cloudflare; existing
pairing identities survive an in-place update. Sensitive pairing, unlock-access
and saved-PIN settings remain local to the phone, with an explanation when a
remote session attempts to change them.

[Release build and signing](https://github.com/kzahel/yepcontrol/actions/runs/39844787724)
passed exact-source full Checks, owned Android 15/API-35 native storage/UI tests,
crypto interoperability and live production hosted acceptance. Source:
`b87030528328ee517719fadcaaa90c8300f327c4`. The signed AAB SHA-256 is
`a12bd1369ce92b5c86fdd457f8ec1deaa413dd09dcd3695d2d703e12b923a134`.
[CI internal publication](https://github.com/kzahel/yepcontrol/actions/runs/39847513476)
verified that exact candidate and committed it to the existing internal track.

The release acceptance run measured process-absent FCM receipt in **3,278 ms**
and fresh encrypted exchange in **6,262 ms**, followed by process/browser restart,
revocation and refusal. Forced hosted fallback decoded **12 H.264 frames in
5.014 seconds**. Native taps, Unicode text, scrolling, held slider/long press,
two-finger gestures, rotation, the input watchdog, global disarm and revocation
passed. The harness confirms approval has actually started and gives scroll
input a real duration; the native effects assertions remain mandatory.

The existing Pixel 9 debug host was separately updated in place to 0.7.0 and its
original pairing reports ready. This is separate from a Play-installed physical
build check. Google review, wider closed testing, Play production rollout and
natural overnight/reboot qualification remain unchanged; the internal release
still shows its temporary unreviewed package name.


## Public production submission — 2026-10-23

The owner subsequently authorized public Play publication. The same signed
0.7.0/code-5 bundle was promoted from Play's library to a production full rollout
and submitted with the saved listing/policy changes. Console now shows Changes
in review, with automated quick checks initially pending. This supersedes the
historical internal-only scope and earlier observed review gate above. Google
approval and public availability are not yet confirmed. See the
[production release record](android-production.md) for provenance, declarations,
review media and remaining acceptance limits.

## Public listing verified — 2026-10-25

Google approved the production submission. The public listing now shows the
product name and Install without sign-in or tester enrollment. This supersedes
the review-pending and invitation-only descriptions above; see the
[production receipt](android-production.md#public-availability--2026-10-25).
Play-installed device acceptance remains a separate check.

## Android 0.8.0 / code 6 — 2026-10-25

The owner authorized implementation, Pixel 7a testing, production deployment and
public Android publication. Source `bd25a918260cd67363093d93869851cc2e6bbe41`
passed [Checks](https://github.com/kzahel/yepcontrol/actions/runs/40218672360).
The [signed Android build](https://github.com/kzahel/yepcontrol/actions/runs/40218672383)
passed on attempt 2 without a source change. Attempt 1 timed out waiting for the
emulator app picker after passing earlier video/input checks; the unchanged
retry passed the full suite. An independent local serial-video profile and
physical Settings launch also passed. This does not establish that the
intermittent emulator timeout has been diagnosed.

The signed AAB is 27,822,257 bytes, SHA-256
`2d13235295cf6da7c179d709544514be1c42607c184b608debf701816d0d491f`.
The [internal publisher](https://github.com/kzahel/yepcontrol/actions/runs/40221360844)
accepted this exact candidate as code 6. Console showed Active / Available to
internal testers at 18:28 UTC. The CI publisher remains testing-only.

The Pixel 7a received the in-place update through Google Play's internal-test
download link. PackageManager reports 0.8.0/code 6 and installer
`com.android.vending`; the installed base APK has the unchanged Play signing
certificate SHA-256
`c17ef33584f126cb2366780acf88949e5cbe6e12925961f86b8588ba727df0ad`.
The existing pairing and screen/background permissions survived the update.
See [physical acceptance](../connection-delay.md) and
[production promotion](android-production.md) for the separate receipts.

## Android 0.8.1 / code 7 — 2026-10-25

Source `95320eeb88d48d04f580e14a0467f6a68f1b4072` passed complete
[Checks](https://github.com/kzahel/yepcontrol/actions/runs/40234299551) and
the [release/signing workflow](https://github.com/kzahel/yepcontrol/actions/runs/40234601316),
including native storage/navigation, hosted pairing/process-absent FCM and
encrypted screen/control, video, held input and rotation smoke acceptance.
The signed AAB SHA-256 is
`6c8887bdd913bd37e3890318544bae3cc15702ca2c36f5ff0ae04b1dc81f71d7`.
The [internal publisher](https://github.com/kzahel/yepcontrol/actions/runs/40235976235)
verified that exact artifact and committed code 7 to internal testing.

The update clarifies the app's controlled-phone role, makes the scanner action
prominent and adds pending/cancellation/retry/lifecycle handling. The existing
protocol, data and signing identity remain compatible. See
[onboarding scope and verification limits](../onboarding.md). Play-installed
physical acceptance and production submission are recorded separately when
established. Physical testing found that closing the real Google scanner
reported its dedicated cancellation error and incorrectly showed a failure
notice. Code 7 was not promoted publicly; the correction is in 0.8.2/code 8.

## Android 0.8.2 / code 8 — 2026-10-25

Source `a2ae8afd9f0829efcb0aa53206198fbd8385fdeb` passed complete
[Checks](https://github.com/kzahel/yepcontrol/actions/runs/40236596729) and
the [release/signing workflow](https://github.com/kzahel/yepcontrol/actions/runs/40236598710)
on attempt 2 without a source change. Attempt 1 timed out waiting for portrait
viewing after rotation, after earlier video/input checks passed. A local full
control run and the unchanged CI retry passed rotation and the remaining
acceptance. The timeout's cause remains unconfirmed; no check was disabled.

The signed AAB SHA-256 is
`fe5ed0b2e78ec980a698b7606f231c72ce065605e16d7f0285ba083505a99fcc`.
This patch handles ML Kit's documented scanner-close error as normal cancellation
and adds a native UI regression for that result. Storage, protocol and signing
identity are unchanged. See [onboarding verification](../onboarding.md).

The [internal publisher](https://github.com/kzahel/yepcontrol/actions/runs/40239183617)
verified and committed that exact candidate as code 8 to internal testing.
The Pixel 7a received the in-place update through Google Play. The installed
version/code, Play installer and original Play signing certificate were verified;
the existing pairing and native permissions survived. Browser control and an
independently observed remote Home action passed. Close cancelled the real
scanner normally, but Android Back still showed a misleading failure notice.
Code 8 was not promoted publicly; see the pinned-SDK analysis and code-9
handling in [onboarding verification](../onboarding.md).

## Android 0.8.3 / code 9 — 2026-10-26

Final source `1d003ca6e4b79eb065165afc9d8556410dc00c9f` passed complete
[Checks](https://github.com/kzahel/yepcontrol/actions/runs/40242348850) and
the [release/signing workflow](https://github.com/kzahel/yepcontrol/actions/runs/40242350547),
including hosted pairing, process-absent FCM and full screen/video/input/rotation
smoke acceptance. The signed AAB SHA-256 is
`518a2f4a610d71c4b9a2d5003c9d030deaaeca283dd9371c092efeaac75d0547`.

Earlier code-9 release attempts at source `983f429` failed at native approval,
once in hosted pairing and once in the control fixture. The final fixture scrolls
approval into view and observes actual native progress/new pairing state before
retrying, retaining the real gesture and signed exchange. Independent local
hosted/FCM and full control runs pass with that fixture. The earlier timeouts are
not counted as passing runs or a proven production root cause.

This update uses neutral no-code copy for the scanner SDK's generic empty-result
error, while retaining specific cancellation and genuine launch-failure handling.
It changes no storage, protocol or signing contract. See
[onboarding behavior and verification](../onboarding.md).

The [internal publisher](https://github.com/kzahel/yepcontrol/actions/runs/40243720558)
verified and committed that exact candidate as code 9. Console showed Available
to internal testers, and the Pixel 7a received the in-place update through
Google Play. Package version/code, Play installer and the original Play signing
certificate were independently verified. The existing pairing and native
permissions survived; browser control and a remote Home action confirmed in
Android's focused window passed. Real scanner Back now shows neutral no-code
guidance; Close returns quietly; retry remains enabled and neither opens a grant.

The temporary pairing was removed on the phone, the browser confirmed Access
removed, and its isolated process exited. Media projection is null. The updated
Play app and normal permissions remain installed. No PIN, lock, debugging or
network settings changed. First-use download timing, natural overnight/reboot
availability and the separate notification-restoration qualification remain
outside these passing checks.
