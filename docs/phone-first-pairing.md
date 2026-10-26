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
