# Relay releases and CI deployment

The 2026-10-26 phone-first pairing rollout is recorded in
[the feature and production receipt](phone-first-pairing.md#production-website-and-relay--2026-10-26).
The live release is `relay-v0.3.1`; it preserves existing v1 grants and adds the
phone-issued one-use QR path, matching viewer and shorter installation page.

Relay versions are independent of Android versions. Use immutable tags such as
`relay-v0.1.0` or `relay-v0.2.0-rc.1`; never move a released tag. The selected
commit must belong to `main` and have a successful complete **Checks** run for
that exact SHA. A tag push runs **Relay release and deployment**.

The workflow tests the Node/shared code and the Cloudflare runtime, builds the
matching Cloudflare viewer and Worker, and retains a version/SHA-labelled artifact
for 90 days. `release.json` records the source, CI run and SHA-256 of every file.
No credentials, Firebase key, pairing database or phone state enters the bundle.

To deploy, dispatch the same workflow on `main` with an existing tag and
`deploy=true`. The deployment job downloads and verifies the exact bytes built
by its build job, then uses the selected `relay-staging` or `relay-production` GitHub environment. Deployments
are serialized; an in-progress deployment is never canceled by a newer request.
The deployment receipt records the tag, commit, CI run, actual Cloudflare Worker
version and a matching HTTPS health check.

The Worker version must match Wrangler's structured `deploy` output, as well as
the tag/source and expected admission. A health response from a previous deployment
of the same tag is insufficient. The verifier waits for the uploaded version to
appear before marking the deployment verified.

The staging target is the isolated **gated Cloudflare staging service**. Staging always
deploys with closed application admission (`PROOF_EXPIRES=1`), no production
domain route, no preview URL and no FCM sender credential provisioning. An
independently provisioned Worker secret supports [automatic FCM renewal](cloudflare-fcm.md);
CI retains that secret and optionally configures its Firebase project. The staging configuration cannot
select the production hostname or normal production Worker name. Existing
Durable Object namespaces and authority remain intact. The Pi relay is now
retired; this workflow neither connects to it nor changes its service or DNS.

`GET /health` exposes only release identity and whether admission is closed.
It does not look up a pairing, allocate an object or prove Android/FCM acceptance.
All staging application paths remain behind the existing fixture gate. Reopening staging
for a bounded live acceptance run remains a separate operation. The separate production target uses explicit maintenance/public admission; see
[production cutover and migration](cloudflare-production.md).

## Environment provisioning

Create a `relay-staging` environment restricted to deployment workflows on
`main`, with these environment values:

| Name | Kind | Meaning |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | Dedicated token with Individual Workers Editor access to the existing isolated Worker. |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Account containing the isolated staging service. |
| `RELAY_WORKER_NAME` | Variable | `yepcontrol-relay-staging`, or the existing isolated `yepcontrol-relay-proof`. |
| `RELAY_ORIGIN` | Variable | Matching HTTPS workers.dev origin, without trailing slash. |
| `FCM_PROJECT` | Variable, optional | Firebase project for the separately provisioned Worker `FCM_SERVICE_ACCOUNT` secret. Omit to disable wake. |

Keep concrete infrastructure values and token provisioning receipts in the
private infrastructure repository. Do not upload the developer's Wrangler OAuth
session or Firebase private key to GitHub. Cloudflare CI authentication requires
an API token; scope it to the one existing Worker using **Individual Workers Editor**,
which can deploy and update that Worker without creating/deleting Workers or
accessing other Workers. Bootstrap a new staging Worker separately before
granting CI access. Avoid account-wide or unrelated zone/DNS permissions.
[Workers permissions](https://developers.cloudflare.com/workers/authorization/workers/)
documents this scope. [Cloudflare CI authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
and [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
were reviewed 2026-10-22.

For `relay-production`, use `RELAY_WORKER_NAME=yepcontrol-relay`,
`RELAY_ORIGIN=https://yepcontrol.com`, required `FCM_PROJECT`, and
`RELAY_MODE=maintenance` or `production`. Optional `RELAY_HEALTH_ORIGIN` may be
the matching workers.dev health endpoint before domain cutover. Bootstrap the
Worker and provision its custom domains separately.

The workflow fails clearly if environment provisioning is absent. Check the
deployment receipt to confirm the actual released source and running version.

## Releasing and recovery

1. Commit and push the intended source to `main`; wait for complete Checks.
2. Create and push its version tag, for example `git tag relay-v0.1.0 COMMIT` and
   `git push origin relay-v0.1.0`. The tag build needs no Cloudflare credentials.
3. Dispatch **Relay release and deployment** on `main`, specifying that
   tag, `target=staging` or `target=production`, and enabling deployment. Inspect the resulting deployment receipt.
4. To redeploy earlier compatible code, dispatch an earlier immutable tag whose
   workflow contains this release pipeline. This rebuilds that pinned source and
   deploys its newly verified bundle; it is not promotion of an older CI artifact.

Code redeployment does not restore SQLite data, deleted authority or an older
schema. Durable Object migration rollback has separate constraints; use a forward
fix when an older release cannot read the current data. Do not restore a stale
pairing database to roll code back. The production target uses its own environment and dedicated Worker; a CI-driven
Pi installer is not part of this workflow.

For local development, keep the Node/SQLite runner and its optional FCM sender.
CI deployment does not change offline/manual operation or couple the Android
release version to the relay version.

## Verified staging deployment — 2026-10-22

[`relay-v0.1.0-rc.2`](https://github.com/kzahel/yepcontrol/tree/relay-v0.1.0-rc.2)
at source `aa29d1d5d36ae143ccd41fded38fc5a9f4bbc204` passed complete Checks and
[CI build/deployment](https://github.com/kzahel/yepcontrol/actions/runs/39781497566).
The uploaded deployment receipt and an independent HTTPS check agree on version
`0.1.0-rc.2`, that source, Worker version
`f09c8883-f776-4d3f-86cb-e82d9cd9a41d` and expected admission. An application request
with the valid fixture key still returned 403. The live Pi's health/revision
remained unchanged.

The first rc.1 upload succeeded, but its health probe received Cloudflare error
1010 with Python's default User-Agent. Rc.2 identifies probes as
`YepControl-Relay-CI/1.0`; the scoped single-Worker token and edge protections
remain unchanged. This verifies the CI deployment path; Android/FCM/video
acceptance is recorded separately in [the hosting proof](hosting-and-turn.md).

The subsequent `relay-v0.1.0-rc.3` release adds normal-client routing, bounded
Cloudflare admission, connection leases and receipt-based backpressure. Both
the tagged CI deployment and a native control/video run passed; a final CI
deployment restored closed admission. See [the measured hardening receipt](cloudflare-hardening.md#live-staging-receipt--2026-10-22).

## Production cutover — 2026-10-22

`relay-v0.1.0` established production CI, preserved authority and passed native
FCM/control acceptance. `relay-v0.1.1` adds the current privacy disclosure; its
Worker, importer and remaining viewer assets match the native-tested bytes.
The [production deployment](https://github.com/kzahel/yepcontrol/actions/runs/39837132249)
verified the canonical HTTPS origin and actual uploaded Worker version with
public admission. Production has its own environment/token, Google sender,
Durable Object namespaces and edge rate-limit counters. Staging remains closed.
See [the complete receipt and recovery rules](cloudflare-production.md).

## Public launch website — 2026-10-25

[`relay-v0.1.2`](https://github.com/kzahel/yepcontrol/tree/relay-v0.1.2), source
`01c625fdffa758e4e41a6fb5c9264706141b51e1`, passed complete
[Checks](https://github.com/kzahel/yepcontrol/actions/runs/40207140946) and the
[production deployment](https://github.com/kzahel/yepcontrol/actions/runs/40207433213).
The uploaded and independently observed Worker version is
`dc952468-12e0-4597-ab91-8bd9d7aff93d`, with public admission.

The website now provides a crawlable product introduction, prominent public Play
installation, metadata and sitemap, while returning browsers retain their saved
phones. QR browser fallback explains public installation and a fresh in-app scan,
without forwarding or persisting the invitation. This does not change the
0.7.0 Android binary, pairing protocol, browser storage or relay authority.

Isolated Chromium checks against the actual public origin pass at mobile and
desktop sizes: product title, visible Play action, install fallback/fragment
removal, saved-phone route, crawler files and Android association. The built-site
suite also verifies decoded pairing QR, no-JavaScript links, no Play referrer and
returning pairings; the existing phone-management/layout and Worker suites pass.
Play-installed physical App Link acceptance remains separate.

Search Console ownership verification passed using the public HTML tag, and the
sitemap was processed successfully with two discovered pages. URL Inspection
confirms the homepage is already indexed. The separate manual recrawl attempt
did not show an acceptance receipt, so it remains unconfirmed. Search titles,
snippets and AI Overview corrections depend on Google's later processing.

## Website copy and source links — 2026-10-25

`relay-v0.1.3`, source `ec92ad56f903ad1598eb0c8dcd922c92c59fa4a5`, passed
[Checks](https://github.com/kzahel/yepcontrol/actions/runs/40208939768) and
[production deployment](https://github.com/kzahel/yepcontrol/actions/runs/40209216723).
Live health confirms Worker `803d8a00-32de-410c-bf81-d308ccbadd6e` with public
admission. The owner-requested copy cleanup removes the large marketing headline,
spare-phone example and version callout. Prominent GitHub/MIT links and Google's
official Play badge appear on the public homepage and installation guide.
Live mobile/desktop checks verify the copy, links, exact badge, QR fallback and
existing viewer routes. Android and the relay protocol are unchanged.

## Prepared connections — 2026-10-25

[`relay-v0.2.0`](https://github.com/kzahel/yepcontrol/tree/relay-v0.2.0), source
`bd25a918260cd67363093d93869851cc2e6bbe41`, passed complete
[Checks](https://github.com/kzahel/yepcontrol/actions/runs/40218672360),
[tag build](https://github.com/kzahel/yepcontrol/actions/runs/40219050566) and
[production deployment](https://github.com/kzahel/yepcontrol/actions/runs/40219050461).
Live health confirms Worker `a74dc0af-6e88-4869-ad08-34f066427646`, version
0.2.0, the exact source revision and public admission.

The viewer retains an authenticated readiness lane for promotion to control,
including a Connect click during startup. Preparation is bounded and only used
when the authenticated phone report advertises support. Public Android 0.7.0
uses one explicit connection without an automatic preceding wake. The relay
allows two immediate authenticated requests per pair, replenishing one every
30 seconds, while preserving global and per-installation limits. Persisted old
cooldowns remain readable and the rollback field remains current. See
[the implementation and measured acceptance](connection-delay.md).

Against production, the Play-installed 0.7.0 Pixel 7a passed explicit control,
Settings launch and two immediate background reconnects (879 ms and 711 ms to
phone-route readiness). A third rapid request was coalesced and cancelled.
The existing pairing also survived a browser restart using its persistent
profile. Exporting/importing a Playwright storage snapshot did not preserve the
nonextractable CryptoKey correctly; that fixture was replaced and revoked.
This was a test-harness failure, not evidence of an application storage loss.

## Pairing roles and links — 2026-10-25

[`relay-v0.2.1`](https://github.com/kzahel/yepcontrol/tree/relay-v0.2.1), source
`95320eeb88d48d04f580e14a0467f6a68f1b4072`, passed complete
[Checks](https://github.com/kzahel/yepcontrol/actions/runs/40234299551) and
[production deployment](https://github.com/kzahel/yepcontrol/actions/runs/40234598931).
Live health confirms Worker `2b4f72ad-9281-41d3-b7b5-cf5a6890a0d0`, version
0.2.1, the exact revision and public admission.

The homepage has separate browser-control and Android-installation entry points.
Browser pairing explains which phone scans and approves, and offers the same
invitation as a copyable link. Valid browser fallback provides an explicit
package-pinned app handoff; the public Play destination contains no invitation.
Fresh isolated live mobile/desktop checks verify both roles, rendered QR decoding
and the fallback. Existing public hosts and pairings remain compatible. Native
scanner feedback requires the separate Android update. See
[the scope, evidence and qualification limits](onboarding.md).

## Mobile pairing entry and recovery — 2026-10-26

`relay-v0.2.2` makes **Control a phone** the prominent homepage
action, with the same large action on saved-phone lists. Browser pairing keeps
role instructions visible during errors, explains service/network/rate-limit
failures and respects retry delays. Temporary approval-poll failures retain the
existing QR rather than discarding it. Completion failures still require checking
the phone before an explicit retry. Installed Android hosts, existing grants,
relay authority and stored formats remain compatible.

Local mobile/desktop Chromium checks cover the primary action's size, order and
visibility, installation, rendered QR decoding, retry countdowns, temporary
failure recovery, expiry during backoff and permanent rejection. TypeScript
checks and all 149 unit tests pass, along with the viewer layout and multi-phone
suites, including lost completion receipts and saved-phone preservation.

Source `b6b33ff011358d747c25e45a02bd4d2e4e48f9f7` passed full
[Checks](https://github.com/kzahel/yepcontrol/actions/runs/40378544034) and
[CodeQL](https://github.com/kzahel/yepcontrol/actions/runs/40378544071), the
[tag build](https://github.com/kzahel/yepcontrol/actions/runs/40379110294) and
[production deployment](https://github.com/kzahel/yepcontrol/actions/runs/40379111887).
The deployment receipt and an independent canonical-origin health check agree
on Worker `ad6cc927-2ff7-4ffa-8364-9c86e6e1a055`, version 0.2.2, that exact source
and public admission.

Fresh isolated Chromium checks against the public origin pass with an Android
mobile browser profile, a 320-pixel mobile viewport and desktop layout. The large
primary action and public installation badge are visible, code creation returns
HTTP 201, and the rendered QR decodes to the canonical enrollment origin. A
controlled mobile network interruption recovers approval polling with the same
QR. An intercepted service failure also verifies the deployed error guidance and
explicit retry without sending that failure fixture to production. These are
browser checks, not hands-on acceptance on the reported Pixel. Android binaries,
the pairing protocol and the running Worker implementation are unchanged apart
from release metadata; the matched viewer is the functional change.

## Clock-sensitive pairing creation and minimal UI — 2026-10-26

`relay-v0.2.3` removes the browser wall clock from invitation creation
and validation, and removes the excessive pairing instructions added in 0.2.2.
The service issues the five-minute deadline before the browser signs a single
creation request. A deadline read allocates no authority. The same short-lived v1 invitation, signature checks and explicit
Android approval remain required. Existing hosts and pairings stay compatible.
The large **Control a phone** entry remains.

Local coverage includes 152 unit tests, real signed browser/Node pairing with
clocks ahead and behind by seconds through ten years, single creation and Cloudflare admission/expiry
checks. The owner's actual device
offset remains unmeasured; the screenshot establishes HTTP 400 rather than its
precise server rejection branch. See [the follow-up](onboarding.md#http-400-follow-up-and-reduced-copy--2026-10-26).

The first full [Checks run](https://github.com/kzahel/yepcontrol/actions/runs/40391856390)
passed the new signed clock regressions, Cloudflare, build/unit/lint and viewer
layout checks, then stopped because the existing multi-phone fixture required
the removed helper paragraph to be visible. That assertion now requires its
absence. The full local multi-phone suite passes with the existing signature,
saved-access, interrupted-completion and contention checks retained.

Final source `201878c43675894505c4b6082f48035d232e5f21` passed complete
[Checks](https://github.com/kzahel/yepcontrol/actions/runs/40394375787),
[CodeQL](https://github.com/kzahel/yepcontrol/actions/runs/40394375037) and
[production release/deployment](https://github.com/kzahel/yepcontrol/actions/runs/40394989583).
The redundant build-only tag run was cancelled so the deployment workflow could
perform its own full source/runtime checks and matched-bundle build. No deployment
job was cancelled and no required check was bypassed.

The uploaded deployment receipt and independent canonical-origin health agree
on version 0.2.3, that source, public admission and Worker
`c4af054e-d19a-4ac1-b306-5e5a9314e1fc`. Fresh isolated Android-profile Chromium
sessions against production completed signed creation, a synthetic phone's sealed
offer and viewer completion with clocks ten years ahead, ten years behind and
accurate. Every case fetched one service deadline and created once with HTTP 201;
the final viewer signature was independently verified. Each temporary synthetic
grant was revoked afterward and its public state returned HTTP 410.

Live 320-pixel mobile and desktop checks also verify the prominent control action,
removed homepage guide, compact pairing page and QR creation. These tests use
isolated browsers and synthetic phone identities; they neither measure the
reported physical phone's clock nor change any phone setting. No Android update,
new protocol/storage format or re-pairing of existing grants is required.

## Unrestricted configuration and CLI client release — 2026-10-30

`relay-v0.4.0`, source `3a4646b125c7f1701967c5c5431a9bebda67884b`, passed
[complete Checks](https://github.com/kzahel/yepcontrol/actions/runs/41135439477),
the [tag build](https://github.com/kzahel/yepcontrol/actions/runs/41136069925)
and [production deployment](https://github.com/kzahel/yepcontrol/actions/runs/41136069666).
The deployment receipt and independent canonical-origin health check agree on
Worker `530bb4d5-8b87-486c-ad9a-d51815bd6aca`, version 0.4.0, that exact source
and public admission.

The matched viewer uses the shared encrypted client, retains existing phone
storage/pairings and removes the obsolete claim that an active controller cannot
grant more configuration authority. The live privacy page explains the new
Android unrestricted-control setting and one-release upgrade rule. No relay
pairing authority, grant format or production database migration is changed.

Fresh isolated mobile/desktop Chromium checks against the deployed origin pass
public installation links, actual rendered pairing QR and privacy disclosure.
The physical Play-installed 0.9.0/code-10 phone reconnects from its preserved
browser grant through this deployed viewer. Android 0.10.0 delivery and its
Play-installed acceptance are recorded separately in the Android release records.
See [the feature qualification](cli-control.md#phase-3-upgrade-adoption-and-complete-regression--2026-10-30).
