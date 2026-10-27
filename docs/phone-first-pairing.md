# Phone-first pairing

Owner-authorized 2026-10-26: implement both pairing directions, test end to end,
deploy the website/service and publish the Android update autonomously. Preserve
public hosts and existing grants. Verify internal Play installation before public
promotion. Physical PIN, lock/debugging settings and unrelated services remain
outside scope.

The phone's protected pairing screen offers **Give control** / **Show code**.
Creating the code is the owner's approval for one browser. The other person scans
it with their camera; `/control#…` opens their browser and automatically exchanges
keys. No Android app or second Allow step is required on that device. The existing
browser-first QR/scanner/Allow route remains available. Keep copy minimal.

The service issues the five-minute expiry. The phone generates a fresh random
128-bit ID and 256-bit secret, signs invitation creation and displays the phone
public key, origin, ID, expiry and secret only in the URL fragment. The secret
never goes to the relay. The receiver scrubs that fragment from history.

A browser signs a claim binding the origin, invitation ID, phone key, expiry,
browser key and browser name, and MACs those same fields with the QR secret. The
phone checks both before automatically signing the unchanged v1 grant. The
browser pins the phone key from the QR and checks the existing grant MAC and
signature before completing. The phone verifies the final browser signature
before storing authority. The relay cannot mint a claim MAC or phone approval.

Only one claim can bind an invitation. Invalid claims never grant access. An ID
known without its secret may be used to deny that invitation; it cannot authorize
a browser. Existing anonymous-service quotas remain in force. Cancellation and
expiry reject later claims/completions; a signed phone cancellation racing final
completion also revokes the resulting relay grant. Local cancellation prevents
late native persistence. Consumed grants use the existing pause/remove controls.

Invitation state is transient, bounded and backward compatible with v1 pending
records. No QR secret is persisted, backed up, logged or added to saved instance
state. Activity recreation may retain an active invitation in memory; process
death cannot recreate approval. The new path adds no phone permission or service.

The pairing page uses Android's secure-window flag, explicitly refuses YepControl
still capture, and stops an existing smooth-video projection while visible. Its
accessibility descriptions never contain the URL. An already approved remote
viewer therefore cannot read the new bearer code to add another browser.
Instrumentation renders its own QR view privately for decoding; that facility is
only in the test APK, not the product. [Android secure-window guidance](https://developer.android.com/security/fraud-prevention/activities?hl=en)
was reviewed 2026-10-26. OS/OEM limits remain separate from the explicit app gate.

## Implementation acceptance — 2026-10-26

The Node suite passes 157 tests, including five real signed phone-invitation
cases. The workerd/SQLite suite passes signed creation, invalid signatures,
competing claims, hibernation before/after approval, unchanged v1 completion and
cancellation racing completion. Existing Worker FCM, flow-control, admission,
revocation and migration tests also pass.

The built-viewer browser suite passes real signed pairing, a ten-year-ahead
browser clock, transient poll failure, lost claim receipt without re-claiming,
phone-key pinning, secret/history scrubbing, replay refusal, cancellation and
one automatic connection. Existing public-site, phone-management and layout
acceptance pass. One layout attempt failed its consent-polling timing assertion;
the unchanged suite passed on rerun. Type checks, formatting, Android lint and
Kotlin protocol tests pass.

On an owned Android 15 emulator, the rendered phone QR decodes, the OS screenshot
does not expose it, Cancel invalidates the invitation, and independent browsers
pair in each direction and complete encrypted native checks. Both fixture grants
are removed. Native navigation and local-security tests also pass, including
rejection of remote Show code input and app capture on the protected pairing page.
Private receipts remain in ignored `.local/phone-first-proof/` and
`.local/mobile-ui-proof/`. The local hosted run used a temporary HTTPS endpoint;
this is not Play-installed physical acceptance or background/overnight evidence.

Android 0.9.0/code 10 is the prepared candidate. The release emulator workflow now
requires both pairing directions against its configured acceptance relay.
Deployment, internal delivery, physical acceptance and production submission
receipts are recorded separately when verified.

The same native candidate also passes the existing owned-emulator control suite
against production using browser-first pairing: encrypted viewing, tap, Unicode
text, swipe, held touch, long press, two-finger input, display rotation, held-input
watchdog, navigation, global disarm and revocation. Smooth video decoded 63 frames
over 5.003 seconds. This confirms compatibility with the pre-feature production
service; it does not establish physical or overnight acceptance. The private
receipt is `.local/phone-first-control-proof/result.json`.

The installation page now presents the two phone-first actions and one short
fallback for older apps. It removes the previous three-step instructions and
repeated installation/pairing reminders. Public-site acceptance passes.

## Production website and relay — 2026-10-26

`relay-v0.3.0`, source `ef136519a0b89a54bf0b0d96d33b950ff198c7f7`, passed
[full Checks](https://github.com/kzahel/yepcontrol/actions/runs/40402147207) and
[production deployment](https://github.com/kzahel/yepcontrol/actions/runs/40402903024).
The verified Worker version is `fa712b13-bf02-441d-89cf-45c990b7e6ae`.
`relay-v0.3.1`, source `c532dab469b629b6fe62fa54f2e409fc922a3318`, adds the shorter
installation page and passed
[Checks](https://github.com/kzahel/yepcontrol/actions/runs/40403274872) and
[production deployment](https://github.com/kzahel/yepcontrol/actions/runs/40404039762).
Its uploaded and independently observed Worker version is
`c89afddf-5319-4a4f-ac00-de21d2c184d0`, with public admission.

The owned Android 15 fixture passes both QR directions against the actual
production Worker and built website: rendered native QR decoding, secure-window
capture exclusion, cancellation returning 410, and encrypted native checks from
two independent browser identities. Both grants are removed. The private receipt
is `.local/phone-first-production-proof/result.json`. A physical Play-installed
0.8.3 host's existing test pairing also connects securely through the new relay.
These checks do not establish delivery or acceptance of the new Android release.

An additional owned-emulator run against `relay-v0.3.1` explicitly waits for the
live remote-screen region and enabled Disconnect action after phone-first pairing,
without tapping Connect. It passes automatic encrypted connection, both pairing
directions, cancellation, capture exclusion and cleanup. A fresh installation
correctly asks for screen-access permission inside that connected session. This
check is now retained in the mobile acceptance harness; its private receipt is
`.local/phone-first-automatic-proof/result.json`.

## Android delivery and production status

Android 0.9.0/code 10 is available through internal Play and passes installed
Pixel 7a acceptance: original Play signer, preserved pre-update pairing and
permissions, encrypted control, independently observed remote Home, QR creation,
capture exclusion, local cancellation and fixture revocation. See
[the exact build/delivery receipt](distribution/android-beta.md#android-090--code-10--2026-10-26).

The accepted bundle was submitted for full public rollout on 2026-10-27.
Console confirms **Changes in review / Production / 0.9.0 / Start full rollout**.
Managed publishing is off, allowing automatic publication after approval.
See [the production submission receipt](distribution/android-production.md#production-review-submitted--2026-10-27).
Google approval and public availability of the new app remain pending.
