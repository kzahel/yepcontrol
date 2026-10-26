# YepControl — agent instructions

## Product intent

Build understanding of a potential standalone consumer product for remotely
reaching an Android phone. Its name is **YepControl** (owner decision,
2026-10-21); use it in user-facing text. The owner requested the domain/identity cutover on 2026-10-21: use
`https://yepcontrol.com` and application ID `com.yepcontrol.app`. The repository
is `kzahel/yepcontrol`; Kotlin source package names retain their working names.
See `docs/app-links.md`. Distribution, architecture details and business model
remain open. Do not fold it into Yep Anywhere merely because YA and Machine
Control contain useful pieces.

The inspiration is a phone left in an RV near an Anker power station: the owner
wants to check battery level and solar charging through its Bluetooth app.
Adjacent uses are an old-phone security camera, a remote app that needs manual
login repair, and a dedicated phone that runs simple home/RV automations.
Repairing YA Android-host provider authentication is a concrete example of
manual control remaining useful when AI authentication has failed. It is not a
requirement to use YA, an AI account, an agent session or a subscription model.

The intended experience is approachable to someone who does not know ADB,
Tailscale, ports or foreground services. Explain readiness and repair actions
in ordinary language. Manual access must be useful on its own. Do not silently
expand the project into autonomous phone control, an agent harness, MDM or a
combined camera/Bluetooth product.

## Current authorization and reading

This repository began with research and an explicitly authorized emulator spike.
Later implementation authorization is recorded below. The originating request
authorizes repository creation, use-case and sibling documentation,
competitive/UX research, Git initialization and a
commit of that work. Brainstorming and “we should build this” are not sufficient
reason to choose a brand, impose a YA integration, install software on phones
or change their lock/debugging settings. Follow later explicit instructions.

The later spike request authorizes emulator setup, synthetic lock credentials,
implementation, tests and incremental commits. It does not authorize changing
physical-phone settings, publication or a production architecture. See
`spike/README.md` and `docs/spike.md` for the runbook and measured scope.

The subsequent explicit request to control the attached Pixel 7a authorizes
installing this test host and accepting its visible accessibility/screen-sharing
permissions, with automated physical-host tests and incremental commits. Keep
this separate from the earlier Pixel browser-client trial. Preserve other
services, apps and transports; do not change lock credentials or debugging
settings. Physical credential entry, reboot/Doze qualification and publication
are outside this extension. See `docs/phone-spike.md`.

A later 2026-10-19 owner request authorizes installing the host on the
attached Pixel 9 and testing remote unlock with the owner's own PIN, entered by
hidden prompt or saved in an owner-only `.local/` file. It does not authorize
reading that file, changing lock settings or retrying a failed attempt.
The owner then authorized a Tailscale transport spike with Tailscale already
running on the computer and the Pixel 9, including turning the phone's Wi-Fi off
and on through the remote control. It does not authorize changing Tailscale
configuration, other network settings or debugging settings.

The 2026-10-19 follow-up authorizes continuous touch/smooth viewing, automated
tests and use of the attached Pixel 7a. The current hardware trial uses it as
the browser client; it does not install the host APK or change its lock/debugging
settings. See `docs/touch-spike.md` for the measured role and limits.

The 2026-10-20 owner request to use the attached Pixel 7a for testing extends
its role to the new hosted pairing/FCM host acceptance. This includes temporary
test-package installation, normal Grant/notification consent, process reclamation
and screen-off forced-Doze checks with battery/idle overrides restored afterward.
Preserve the earlier spike and other applications. This does not authorize PIN
entry, lock/debugging changes or reboot testing. See `docs/fcm-wake-v1.md` for
the measured result; natural unplugged overnight qualification remains separate.

Read README.md and the applicable documents under docs/ before proposing work.
Keep product decisions separate from hypotheses and implementation evidence.
Do not mark something implemented or authorized beyond what the user requested.
Do not create approval rituals for ordinary reversible research or docs edits.

The 2026-10-20 owner decision authorizes proceeding with the standalone product
in this repository, preserving the existing executable prototype under `spike/`
and building clean production components at the root. Use TypeScript for the
relay/protocol and React viewer, and Kotlin for Android, with reproducible
builds, tests and lint. See `docs/production-plan.md` for the planned layout,
implementation defaults and open release decisions. This supersedes the earlier
new-repository proposal; it does not authorize publication, production deployment,
new device-setting changes or changes to unrelated sibling products. Use the
pinned YA FCM reference in `docs/sibling-repositories.md` without making YA a
runtime dependency.

The later 2026-10-20 owner request authorizes implementing the next pairing/relay
slice, deploying its development service on the Pi, adding the proposed HTTPS
hostname and DNS/Caddy configuration in dotfiles, and committing both repositories.
Keep the service independent of existing products. This does not authorize Play
publication, new physical-phone lock/debugging changes or unrelated service changes.

The subsequent owner request authorizes the complete mobile-management slice:
Room/SQLite and migration, multiple paired browsers and local nicknames, global
and per-browser access switches, Settings, local activity history, end-to-end
verification and incremental commits. Keep the existing plain native appearance
and generic utility copy. See `docs/mobile-management.md`. This extends the
current pairing/wake product; it does not claim screen control has been ported or
authorize new physical-phone lock/debugging changes.

The later owner request authorizes driving the complete control implementation
end to end with incremental verified commits and the existing Pi deployment.
Saved PIN, continuous touch, smooth video and direct WebRTC/fallback are in scope;
see `docs/control-completion.md`. Use owned emulators with synthetic credentials
for unlock/reboot tests. The attached Pixel 7a remains authorized for ordinary
host/accessibility/capture/FCM tests, not physical PIN entry, reboot or lock/debugging
changes. Play publication is not authorized.

## Initial development: no backward compatibility

Release status update, 2026-10-22: the owner's later request authorizes the
public MIT repository, CI signing/publishing and the free Tools-category,
13+ internal Play beta. Version 0.7.0/code 5 is now active on internal testing.
Store/policy forms are saved; Google review and Play-installed physical
acceptance remain separate. Closed expansion follows the installed-build check;
production rollout is not authorized. See `docs/distribution/android-beta.md`.
The pre-release owner statement below is historical now that an internal build
exists. Revisit compatibility before the next protocol/storage-breaking change.

YepControl is not live and has no non-debug builds (owner statement,
2026-10-21). During initial development, do not maintain backward
compatibility: change protocols, stored formats, databases and APIs directly,
require new fields instead of making them optional, and reinstall or re-pair
test devices when formats change. Do not add schema migrations, version
negotiation or fallbacks for older app, website or relay versions. The Room
migrations written so far were practice and are not a policy. Revisit this
before the first public or release build.

## Research discipline

- Prefer official Android/Firebase documentation, official vendor help, and
  pinned source over marketing summaries or recollection.
- Record review date, exact URLs, important version limits and whether evidence
  is platform-documented, vendor-claimed, source-reviewed or physically tested.
- A product listing is not proof of reliable unattended control or Play approval
  for our eventual implementation. Distinguish remote viewing, input, secure
  unlock and unattended recovery in every comparison.
- Do not infer UI behavior from marketing alone. Label documentation-based
  walkthroughs and proposed flows; do not present them as hands-on UX research.
- Recheck prices and licensing at decision time. Do not invent prices, session
  limits, security guarantees or absent competitor features.
- Keep screenshots, raw web captures, logs, credentials, device selectors and
  machine-specific inventories out of Git. Use .local/ for private evidence.
- Native code and APK reuse require exact-component license review. A sibling
  repository's license does not license all of its bundled dependencies.

## Technical boundaries to preserve

Keep process wake, display wake, keyguard dismissal, credential entry, first
unlock after reboot, capture consent, input authority and network reachability
distinct. ADB is a candidate advanced route, not root or an unlock bypass.
Accessibility input and screenshots have OS, app and OEM restrictions.

FCM is a best-effort wake hint, not remote authentication or a command channel.
A persistent WebSocket does not override Doze. Foreground services, battery
exemptions, companion-device associations and nearby-device permissions each
have a specific purpose; do not claim they guarantee survival or use unrelated
permissions just to keep a process alive.

Never commit PINs, tokens, ADB keys, OAuth state or app data. Optional saved-PIN
design must account for native storage, backup exclusion, explicit opt-in,
one-attempt delivery, lockout policy, local forgetting and unattended key
availability. Do not silently weaken device lock or boot security.

## Working with siblings and verification

See docs/sibling-repositories.md. Read each sibling's own AGENTS.md and local
instructions before changing it. Keep reusable device primitives in their
proper owner when that makes sense; do not assume this product needs YA's
server, Alpine/PRoot or an AI runtime. Preserve concurrent edits.

Prefer deterministic CLIs, official APIs, existing capture/test runners and
isolated fixtures. Use explicit device selection. Do not kill a shared ADB
server, change debugging listeners, install a competitor or enter credentials
on a real phone without task authorization. Hands-on tests must preserve state
and distinguish foreground success from reboot/Doze/overnight acceptance.

For documentation-only changes, verify links, evidence consistency and
`git diff --check`; do not add shallow tests or an application scaffold solely
to make this research repository look implemented. Commit on the current
branch unless instructed otherwise. Attribute model contributions with only a
`Contributing-model: <short-model-name>` trailer, not model authorship banners
or Co-Authored-By lines. Do not publish/push without authorization.

## Beta and public-source authorization — 2026-10-21

The owner authorized public MIT source after a history/private-infrastructure audit,
CI-driven Play beta publication, release assets adapted from owned YepAnywhere
branding, and a website privacy policy. Audience is 13+ (13–15, 16–17 and 18+),
category Tools, free installation, no ads, and no required account. Start with
internal testing and verify the Play-installed build before wider closed testing.
This does not authorize production rollout or unrelated sibling/infrastructure changes.
Private signing/IAM/tester inventories stay in dotfiles; public source carries
only generic provisioning instructions and public client configuration.

## Production relay authorization — 2026-10-22

The owner authorized Cloudflare production relay cutover at `https://yepcontrol.com`,
versioned CI deployment, a dedicated send-only FCM identity with renewable Google
access tokens, migration of existing pairing authority, and retirement of the Pi
relay. The production Worker and SQLite Durable Objects now serve that origin;
the Pi relay and its backup timer are disabled, with historical authority retained
privately. Do not reactivate the stale Pi database after Cloudflare writes.
Keep the Node/SQLite runner for local and self-hosted operation. Pi coturn remains
an investigation, not an installed service. See `docs/cloudflare-production.md`
and `docs/relay-releases.md`. This authorizes relay production, not a Google Play
production rollout or new physical-phone lock/debugging changes.


## Public Play publication authorization — 2026-10-23

The owner authorized publishing YepControl publicly on Google Play. This
supersedes the earlier internal-only Play publication limit. The existing signed
0.7.0/code-5 bundle has been submitted for production full rollout, with all
available countries/regions selected and managed publishing off. Console shows
Changes in review; initial automated checks, Google approval and actual public
availability must be distinguished. See `docs/distribution/android-production.md`.
The CI publisher remains scoped to internal testing. This does not authorize
unrelated infrastructure changes or new physical-phone lock/debugging changes.

## Public Play availability — 2026-10-25

The owner reported approval, and a signed-out public-listing check confirms
YepControl is live with Install and no tester enrollment. Version 0.7.0/code 5
is now a public release. Preserve compatibility with that installed app when
changing the viewer, relay or stored formats; the historical pre-release policy
above no longer applies. See `docs/distribution/android-production.md`.

## Prepared connections and release authorization — 2026-10-25

The owner authorized implementing bounded reuse of readiness connections,
testing on the attached Pixel 7a, incremental commits/pushes, Cloudflare production
deployment and a new Android release through Play, autonomously end to end.
Use internal Play delivery for physical acceptance before public promotion.
Preserve compatibility with public 0.7.0 hosts and existing pairings. This does
not authorize physical credential entry or lock/debugging changes. See
`docs/connection-delay.md` for the baseline and implementation evidence.

## Phone-first pairing and release authorization — 2026-10-26

The owner authorized implementing and testing both QR directions autonomously,
deploying the website/service, and publishing the Android update through Play.
Showing a phone-issued code is explicit approval for its first valid browser
claim; no second Allow step is required. Preserve the browser-first flow and
existing grants, use short-lived single-use codes and internal Play-installed
acceptance before public promotion. Physical credential entry, lock/debugging
changes and unrelated infrastructure remain outside scope. See
`docs/phone-first-pairing.md`.
