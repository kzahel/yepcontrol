# Pairing and hosted relay v1

Experimental development service, specified 2026-10-20 before implementation.
This slice establishes durable trust and forwards the existing encrypted session;
it does not grant screen capture, input, unlock, FCM or WebRTC capability.

## Enrollment

The browser-first exchange below remains available. Android 0.9.0 also adds
[phone-first pairing](phone-first-pairing.md): the protected phone screen issues
a one-use QR, and its holder's browser claims it before the same v1 grant
exchange. Existing pairings and installed older hosts keep their original flow.

The browser creates a non-exportable P-256 identity in IndexedDB and an ephemeral
256-bit QR secret. The QR is an HTTPS App Link at `<relay origin>/enroll#<base64 JSON>`;
[Android App Links and the install fallback](app-links.md) are configured for
`yepcontrol.com`. The outer URL origin must match the signed invitation origin.
The QR URI fragment contains version, HTTPS relay origin,
random 16-byte pairing ID (hex), viewer SEC1 public key (base64), expiry (Unix
seconds, at most five minutes), secret (hex) and an optional browser label such
as "Chrome on macOS" (1–40 characters, trimmed, no control characters). The
secret never goes to the relay. The phone receives this through the scanner or
normal pairing deep link, validates both origins against the selected
build-configured website, displays the label and relay host, and requires Allow.
Release builds accept only their configured production origin; debug builds may
explicitly select a configured development origin before enrollment. The label is
the default nickname; it is the QR creator's claim, not an authenticated identity. Test instrumentation
supplies the decoded rendered QR at this same boundary and presses Grant.

Signed/HMAC messages are UTF-8 fields joined by newline; fields cannot contain
newlines. Public keys are canonical base64, IDs/secrets lowercase hex, timestamps
decimal integers. Phone grant G is `ara/pair/grant/v1`, relay origin, ID,
viewer key, phone key, expiry. The phone signs G and computes HMAC-SHA256(secret,
G). The browser verifies both and signs G. The relay verifies both endpoint
signatures before durably recording the relationship. The phone also verifies
the browser signature before persisting its grant. Enrollment IDs are single-use;
expired or consumed requests cannot overwrite durable authority. No relay-held
secret can manufacture a phone HMAC for a fresh QR. An attacker who obtains
the QR can enroll; it must not enter URLs sent to a server, logs or analytics.

Create requests are viewer-signed over `ara/pair/create/v1`, origin, ID, viewer
key, expiry. Pending enrollment is bounded, memory-only and lost on restart.
The browser first fetches `GET /api/pairing-time`, which returns `serverTime`
(Unix milliseconds) and `expires` (Unix seconds) with `Cache-Control: no-store`.
This read is rate-limited and allocates no pairing authority. It signs the returned
expiry and tracks its remaining lifetime with monotonic elapsed time; its own wall
clock is unused. The service still rejects a creation expiry outside its existing
five-minute window before allocating authority, returning HTTP 400 with
`error: "clock-skew"` and `serverTime`. Creation errors and completion requests
are never automatically replayed. The additive endpoint/error does not change
the v1 grant or installed Android parser. See
[the clock regression](onboarding.md#http-400-follow-up-and-reduced-copy--2026-10-26).
Public polling returns only a phone's signed offer, never the QR secret.
A poll may send `Pair-Wait: <state it already has>` (`waiting` from the browser,
`offered` from the phone). The relay then holds the reply until the state
changes, the code expires or 15 seconds pass, so each endpoint reacts as soon as
the other acts. Holds are bounded (1,000 total, 4 per pairing). Relays without
this answer at once and clients fall back to their earlier poll interval.
The browser holds the QR secret only until completion/expiration. A completed
receipt can be fetched by ID but contains only public keys and signatures.
The phone's offer also carries its device report sealed with the QR secret:
HKDF-SHA256(secret, salt = pairing ID, info `ara/pair/device/v1`) to AES-256-GCM
with that info and ID as associated data (`protocol/vectors/device-v1.json`).
The relay passes it to the browser opaquely in the `offered` reply and never
stores it. A new pairing's first enabled access policy leaves open routes alone,
so the browser's check right after pairing is not cut off.
Phone confirmation polls are bounded. Losing the final receipt may leave a
stale entry on either endpoint. Show that pairing was not confirmed and ask the
owner to check Devices on the phone before another code. Another pairing creates
independent access. Stale entries are allowed and can be forgotten locally;
removing an enabled permission on the phone stops its access. No coordinated
replacement transaction is required; see the owner-approved
[security model](security-gaps.md#sg-5-pairing-again-is-not-revocation).

## Routing and authority

After a viewer's signature verifies against its pinned key, the relay may close
its socket with 4010 (access removed: the pairing is a revoked tombstone) or 4011
(access paused by the phone's policy), on a live route when the phone revokes or
pauses it and on later authentication. A viewer that cannot prove the key gets
the generic 4003. The website records removed/paused for that exact pairing,
clears it on the next authenticated connection, and checks saved pairings for
the public 410 tombstone when the phone list opens. A new pairing may replace
the browser's displayed record, but it does not change the old pairing's relay
authority.


WebSocket clients select a durable pairing ID and role. The relay supplies a
fresh 32-byte challenge. Authenticate by signing newline fields:
`ara/relay/auth/v1`, relay origin, pairing ID, role, challenge. Challenges expire
in ten seconds and are single-use. Each pair admits at most one socket per role;
a second live connection is rejected rather than displacing an existing peer.
Origin is exact for browser WebSocket clients; native clients may omit Origin.
The relay sends `ready` only when both endpoints authenticate. It forwards
binary frames only, with bounded sizes/queues, to the authenticated counterpart.
Loss of either peer closes both; reconnect always starts fresh ECDH and counters.
The relay never interprets encrypted application content.

Phone revocation uses newline fields `ara/pair/revoke/v1`, origin, ID, signed
by the stored phone key. Revocation is persisted before acknowledgement and
closes both routes. Endpoints also forget their local grant; the phone's
current-authority predicate rejects work after local revocation. The relay
retains tombstones to prevent reenrollment with an old ID. Losing/rolling back
a relay database must never create endpoint trust: both endpoints retain exact
peer-key pins. Backup/restore must preserve tombstones; restoring an old backup
requires reconciling subsequent revocations before admission resumes.

The phone enforces removal locally before relay synchronization. Unreachable
relay cleanup leaves a locally blocked record and a pending-cleanup explanation
with retry on the phone. A stale browser card can be forgotten independently.
Browser forgetting deletes only local state and does not revoke a still-enabled
phone permission. Earlier grants remain independent when a browser saves a new
pairing for the same phone.

## Limits and deployment

Bound JSON bodies, pending enrollments, sockets and per-source-IP mutations.
Proxy headers are trusted only from the loopback Caddy hop. Records are at most
1 MiB plus 32 bytes; a slow receiver closes the pair rather than buffering
unbounded input. No automatic replay of application messages is supported.
Public health contains a revision and status, no pairing identifiers.

Private host selection, service configuration, DNS, deployment, backup and
rollback belong in dotfiles. The product repository contains a reproducible
web/relay build and public acceptance runner. This is a development deployment,
not an audited consumer release. Physical camera and overnight FCM acceptance
remain separate from automated decoded-image enrollment.


## Mobile policy extension (2026-10-20)

Each browser has its own pairing ID and pinned grant; a phone identity can grant
multiple browsers. Enrollment and encrypted session formats remain v1. The phone
now persists grants and access policy in Room, with private keys still in Keystore.

An authenticated phone `mode: "registration"` socket may send `setAccess` with
`enabled` and a fresh 16-byte hex `generation`, receiving `accessUpdated` before
registering/removing push delivery. Only the phone management role may change
policy. A changed policy is persisted and closes that pair's pending/active route.
Paused viewers are rejected. Session-role phones must present the current
`generation` once the pairing has opted into this extension. Unextended old grants
remain readable and usable under their original contract.

Push registrations attach that generation. Hints include `pairingId` and
`generation`; the new native host requires both and rejects superseded generations
before scheduling and throughout execution. They select a local pin, never grant
trust. Local disarm/disable/revoke applies immediately even if relay synchronization
fails. Re-enabling rotates the generation again; old requests cannot revive.
Only one native session lease is admitted across all pairings. Management refresh
with unchanged policy does not displace an active encrypted session.

## Optional feature report (2026-10-20)

The native host may send a second encrypted application record after its unchanged
canary reply: a UTF-8 JSON object with `type: "features"`, `v: 1`, `screenViewing`,
`touchControl` and `connectionRequests`. Viewing/control use the finite states
`unavailable`, `permission-needed`, `enabled`; requests use `unavailable`, `off`,
`notifications-needed`, `setup-needed`, `enabled`. The current host queries the
screen-access service for viewing/control readiness. This report conveys no authority and is not
persisted as permission. It is a snapshot from the paired phone during that check.

The viewer validates type/version, finite values, UTF-8 and a 2048-byte maximum,
drops unknown display fields and renders its own text. It waits at most 1.2 seconds
for the optional trailer; older hosts may finish with the canary alone. Older
viewers can ignore the trailer and close as before. The host allows a bounded
one-second drain or viewer closure before ending a successful check. Neither
pairing signatures, the handshake nor the canary bytes change. No relay-visible
capability endpoint is introduced.

Visible-app listeners admit allowed browser grants without capture, accessibility,
notification or wake opt-in. They authenticate with the existing generation and
acquire the shared phone-session lease only when a viewer route arrives. Leaving
the app closes these listeners; process-absent access retains the existing FCM
opt-in/notification requirements. Policy changes invalidate both paths.

## Rapid reconnect wake scheduling (2026-10-20)

A new viewer session creates a fresh wake request ID. The relay retains its
30-second per-pairing push cooldown, but a request arriving during that cooldown
is queued and sent when it ends, within the original request expiry. It must not
rely on an earlier hint whose request ID no longer matches. While queued, the
viewer explains the short wait. Disconnect, revocation/policy changes, phone
arrival and relay shutdown cancel pending delivery; expired requests never send.
This fixes the physically reproduced check-connection → connect-control stall
with the Pixel 9 app in the background. No phone update is needed.

Regression coverage exercises fresh request delivery after a completed earlier
route, rejection of the stale request ID, cancellation on departure/revocation/
phone arrival, expiry and the browser's waiting/delivery messages.

## Prepared sessions and quick reconnects (2026-10-25)

Android 0.8.0 advertises the optional `connectionPreparation: 1` extension in
its authenticated device report. The existing canary/features exchange can stay
open for up to 30 seconds and receive the unchanged control-start command on the
same encrypted lane. Old viewers still close the check normally; viewers do not
require this extension from public 0.7.0 hosts. See
[connection preparation](connection-delay.md#prepared-session-implementation--android-080--code-6).

The per-pair fixed push cooldown above is replaced with a two-request token
allowance, replenishing one token per 30 seconds. Two fresh authenticated
requests may send immediately; subsequent requests use the existing queued
wake, expiry, cancellation and policy checks. Node and Cloudflare use the same
calculation. Cloudflare persists the tokens and carries an existing numeric
cooldown forward as one consumed request. The legacy numeric field remains
updated for conservative code rollback. Global and per-installation send
budgets are unchanged. New native hints queue behind prior worker teardown;
they cannot cancel active input, reuse old request IDs or extend expired grants.
