# YepControl domain, Android identity and App Links

Owner-requested cutover: **2026-10-21**. The canonical website/relay origin is
`https://yepcontrol.com`; `www` redirects to it. The Android application ID is
`com.yepcontrol.app`: reverse domain ownership with room for future products.
The Kotlin namespace `dev.remoteaccess.app` and reusable protocol source packages
remain internal implementation names. The preserved `spike/` is unchanged.

The renamed app is a separate Android installation. Reinstall/re-pair development
fixtures; no data, browser-origin or old-link compatibility is provided. Existing
browser IndexedDB identities stay on their original origin. Relay signatures bind
the origin, so old grants cannot be reused at the new origin.

## QR and installation behavior

Pairing QR codes encode `<relay origin>/enroll#<base64 invitation JSON>`.
Both TypeScript and Android validate HTTPS, `/enroll`, no credentials/query,
expiry, keys and equality between the outer origin and invitation origin.
Android additionally pins both origins to the selected build-configured website.
Release builds accept only `sharingWebsite` (default `https://yepcontrol.com`).
Debug builds may explicitly select their compiled `devSharingWebsite` in Settings
before scanning. Other hosts, subdomains and ports are rejected without network
activity; a QR cannot choose another service. Both scanning and incoming links
apply this policy. The approval screen always displays the host and explains
that the device name is supplied by the other device.
The fragment contains the short-lived secret and never goes to HTTP servers.
The app still requires explicit **Allow** after a scan or link open.

Android declares an auto-verified HTTPS filter only for
`https://yepcontrol.com/enroll`. The website directly serves JSON at
`/.well-known/assetlinks.json` with `com.yepcontrol.app` and the certificate
SHA-256 fingerprint. Other viewer routes continue opening in the browser.
Configured and selected local development origins work through the in-app
scanner; they do not claim verified links for arbitrary development domains.

With the associated app installed, an external QR scanner that opens the URL can
route to YepControl. Without the app, `/enroll` serves an install page with a
Google Play link to `https://play.google.com/store/apps/details?id=com.yepcontrol.app`.
It clears the fragment from browser history and never appends it to Play URLs,
stores it or sends it to analytics. After installing, open the app and scan a
fresh code. This is not deferred deep linking; installation does not resume or
approve a pairing. Scanner/browser behavior can vary.

**Public availability verified 2026-10-25.** The Play listing opens signed out
with the public product name and Install, without tester enrollment. The install
page now links directly to the public listing and explains the fresh scan after
installation. The existing HTTPS App Link and Android binary are unchanged;
a scanner may still open the fallback browser page even with the app installed.
Use the in-app scanner in that case. Play-installed physical App Link acceptance
remains separate from the previously verified owned-emulator behavior.

## Firebase and signing

The Firebase project/sender stay the same. A real new Firebase Android client is
registered for `com.yepcontrol.app`; its downloaded public client configuration
is checked in. Merely editing the old package name in the config would not create
this registration. No sender credentials or signing private keys belong in Git.

The association trusts the existing development APK certificate and all three
**Play app signing certificate** SHA-256 fingerprints copied from Play Console
on 2026-10-21, including its quantum-ready signing lineage. The fingerprints are
public in `assetlinks.json`; none is the upload certificate. Other machines'
debug keys will not verify automatically. Actual Play-installed verification is
recorded in the [beta guide](distribution/android-beta.md).

## Verification and sources

Run the ordinary build/type/lint/test checks and
`HOSTED_ORIGIN=https://yepcontrol.com HOSTED_FCM=1 pnpm test:hosted`.
The owned-emulator runner waits for Android's actual `verified` domain state,
checks native URL validation, opens the rendered/decoded QR through Android's
implicit App Link resolver, exercises Grant/E2E/reconnect/revocation and checks
the browser install page. FCM mode separately tests the renamed registration.
Private reports and screenshots stay under `.local/hosted-proof/`.

Official documentation reviewed **2026-10-21** (platform-documented, separate
from test receipts):

- [Website association format and Play signing fingerprint](https://developer.android.com/training/app-links/configure-assetlinks).
- [Android domain verification commands](https://developer.android.com/training/app-links/verify-applinks).
- [Google Play listing URLs](https://developer.android.com/distribute/marketing-tools/linking-to-google-play).
- [Firebase Android registration: package names cannot be changed](https://firebase.google.com/docs/android/setup).

## Acceptance receipt — 2026-10-21

Deployed product revision `94ec227c1fa09f1436b2ba7945b34a3d4eab148d` passes
public HTTPS/WSS health. `www` returns 301 to the canonical origin.
`/.well-known/assetlinks.json` returns 200 with `application/json`, no redirect;
a missing association file returns 404 instead of the viewer HTML.

The owned API-35 emulator reports `yepcontrol.com: verified` for
`com.yepcontrol.app` and the actual development signing certificate. Native
URL-validation instrumentation passes, and the real rendered QR opens the
Grant screen through Android's implicit App Link resolver. Pairing, three or
more encrypted exchanges, persisted reconnect after Android process restart and
browser reload, durable revocation and rejection after revocation all pass.
The renamed Firebase client receives a real wake after process reclamation with
no application socket: 427 ms to native receipt and 724 ms to the native
encrypted exchange in this run (clock estimate uncertainty 9 ms). These are one
emulator run's observations, not latency guarantees or overnight/OEM evidence.
The runner's revocation expectation now recognizes the current viewer copy.

Isolated Playwright Chromium checks the install page and exact Play destination,
fragment removal and a 360 × 800 mobile viewport without horizontal overflow or
heading clipping. Build, type checks, TypeScript/Android lint, formatting, 105
TypeScript tests and Kotlin protocol tests pass. The Node transport-status test
mocks its browser storage sink so it does not open IndexedDB outside a browser.
The browser and owned emulator are reaped. No physical phone was selected and
no Play listing or release build was published.

## Enrollment origin pinning (2026-10-22)

SG-2 is implemented in the Android source. The selected build-configured origin
is mandatory in the shared scanner/link parser. HTTP requests, WebSocket
connections, new stored grants and existing-grant authority also enforce the
build's configured origins. A debug website switch affects new enrollment;
existing grants for either compiled origin remain usable. Grants for other
origins remain visible as unavailable and can be removed locally without
contacting that service. The database schema and valid existing grants are
unchanged.

`EnrollmentLinkTest` now has six tests covering matching attacker-controlled
origins, subdomain/suffix/port variations, mismatched outer/invitation origins,
explicit debug-origin selection, network-entry-point rejection, conservative
label validation and actual incoming-link UI. The UI check also delivers an
invalid link to an already open approval screen and verifies that the previous
approval is removed and the expected service is explained. `HostStoreTest`
covers rejection of new off-origin grants and preserved-but-disabled old grants,
including attempts to re-enable them.

`pnpm test:mobile-smoke` passes all 17 native tests (two navigation/security and
15 storage/enrollment) on an owned API-35 emulator in both configurations:

- Default production origin with
  `-PdevSharingWebsite=https://development.example`, exercising explicit debug
  selection without contacting that synthetic service.
- A separate deployment compiled with
  `-PsharingWebsite=https://deployment.example -PdevSharingWebsite=`, exercising
  a different sole service origin and rejection of a stale development preference.

Build the debug app and instrumentation APK for the desired configuration with
`:app:assembleDebug :app:assembleDebugAndroidTest`, then run the smoke command.
The production release configuration has `DEBUG=false` and an empty development
origin even when a development origin was supplied to the build. Debug and
release APK builds, Android debug/release lint, Kotlin formatting and protocol
tests, TypeScript type checks/Biome/120 tests, 12 publishing-regression tests and
the changed workflows' Actionlint checks pass.

The final production-origin debug build also passes `pnpm test:hosted` against
the existing HTTPS service: rendered QR decoding, normal native Grant, encrypted
exchanges, persistence after Android process restart and browser reload, durable
revocation and rejection afterward. All six native origin/link tests pass in
that run. OS domain association is excluded for this run's explicit native
intent; it does not repeat the earlier verified-App-Link acceptance above.

Private receipts stay in `.local/sg2-proof/`. No physical phone, Play release or
deployment is changed by this verification.

## Public website and search — 2026-10-25

The root now serves product HTML with a prominent public Play link, QR setup
steps, product title/description, canonical/social metadata and WebSite microdata.
Browsers with saved phones load their existing library at the same root; `/phones`
also opens it directly. No pairing authority, origin, IndexedDB format or Android
App Link changes. The former root symlink to the preserved spike is replaced by
production HTML; `spike/` remains unchanged.

`/enroll` and `/install` serve the same public installation guide with no tester
requirement. The invitation fragment is cleared, never persisted or appended to
the Play link. Both public pages and their install links work without JavaScript;
fragment clearing requires JavaScript, while the no-referrer policy and fixed
Play URL prevent forwarding it in either case. Native enrollment still requires
Grant. Private viewer/pairing/install routes carry `noindex`; the public sitemap
contains only the product homepage and privacy policy. A public homepage meta tag
supports the owner's Search Console verification, without adding analytics.

`pnpm test:public-site` exercises the built assets under the hosted CSP in isolated
Chromium: initial HTML/metadata, mobile/desktop layout, Play CTA above the fold,
decoded pairing QR, fragment clearing, exact Play URL/no referrer, no-JavaScript
installation links and returning saved-phone navigation. The hosted Worker tests
check the actual asset routing, including App Links and crawler files. The existing
browser layout/phone suites remain separate. These checks do not establish
Play-installed physical App Link handling or changed Google search results.

The `relay-v0.1.2` production deployment and independent live mobile/desktop smoke
pass. Google Search Console verified ownership by the public homepage meta tag
and processed `/sitemap.xml` successfully, discovering two pages. These are
Search Console results, not evidence that search titles/snippets or AI Overviews
have already updated. See the [deployment receipt](relay-releases.md#public-launch-website--2026-10-25).

URL Inspection reports the homepage is already on Google. Manual Request indexing
started a live indexability check, then returned to inspection without an
acceptance receipt, including after refreshing Search Console and one retry.
The manual recrawl is therefore unconfirmed; the successfully processed sitemap
is the confirmed discovery submission. No change to search-result text or the
incorrect AI Overview is claimed.

## Role-aware onboarding and optional scanning — 2026-10-25

The website retains explicit controller and controlled-phone installation paths.
The app's public QR now opens `/pair` on the controlling device; it is clearly a
shortcut to browser setup rather than a grant. The controlling browser can
provide either its QR or a user-copied invitation App Link. An installed host
still requires local Allow. The fallback can offer an explicit package-pinned
Android intent for a valid invitation held only in memory; history is scrubbed,
and the fixed Play fallback receives no invitation. Installation never resumes
or approves pairing automatically. This supersedes the older scan-only fallback
copy above. See [onboarding behavior and verification](onboarding.md).
