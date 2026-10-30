# Security decisions and open gaps

Reviewed 2026-10-22. This document records the current security boundary,
accepted product decisions and gaps found in a source review of the production
pairing, relay, wake and control paths. It is not an independent audit or a
claim that the service is ready for broad release. The preserved `spike/`
implementation is outside this review.

## Summary

| ID | Topic | Status | Required disposition |
| --- | --- | --- | --- |
| SG-1 | Paired-controller authority | Intentional product behavior | Explain the trust granted to an active controller. |
| SG-2 | Enrollment-origin pinning | Implemented in source; release delivery pending | Ship the origin-pinned Android build. |
| SG-3 | Relay enrollment-storage exhaustion | Mitigated for development/self-hosting; public-service policy open | SQLite and small admission budgets bound work; distributed abuse can still deny new enrollment. |
| SG-4 | FCM before the end-to-end session | Protocol behavior accepted; abuse controls open | Preserve endpoint authentication while adding fair wake quotas and monitoring. |
| SG-5 | Pair-again semantics | Simplified model implemented; delivery pending | Pairing adds access; enforce removal on the phone and allow stale entries with best-effort cleanup. |
| SG-6 | Hosted viewer origin | Intentional trust boundary | Treat deployment integrity as endpoint security. |
| SG-7 | HSTS | Enabled and verified 2026-10-22 | Maintain the explicit hostname policies; evaluate broader coverage and preload separately. |

## SG-1: a paired controller is highly trusted

The owner accepts that a paired, enabled browser can operate the phone UI with
the authority of the enabled screen-control service. That includes navigating
ordinary YepControl management screens, enabling supported background-access
features, managing other browser grants and opening relevant Android settings.
This is intentional product behavior, not an isolation boundary between an
active controller and the phone's on-screen UI.

The product should say plainly that enabling control is comparable to handing
someone an unlocked phone for the duration of the session. With **Allow
unrestricted remote control** enabled, it also includes pairing approval,
per-device unlock configuration and saved-PIN setup. These screens are protected
when that setting is off, but an existing trusted controller can intentionally
enable it from ordinary Settings. Code 11 enables it once for eligible paired
upgrades; see [the release-specific rule](cli-control.md#one-release-upgrade-rule).
Changing this setting does not itself grant credential-entry authority. Global and per-browser access switches
remain useful for the local owner to pause or revoke access, but they must not
be described as protection from a malicious controller that is already active
and allowed to operate those same screens.

## SG-2: release builds must pin the enrollment origin

Implemented 2026-10-22. The scanner and incoming links use the same invitation
parser, which requires both the outer URL and the invitation to match the exact
selected build-configured HTTPS origin before approval or network activity.
Release builds accept only `SHARING_WEBSITE`, currently
`https://yepcontrol.com`. This pins a service origin, not a TLS certificate.

Debug builds can select an explicitly compiled `DEV_SHARING_WEBSITE` in Settings;
a scanned invitation cannot select it. The switch applies to new enrollment.
Existing grants on either configured origin remain usable when the debug switch
changes. Separate deployments must build with their own `sharingWebsite` value.
Release builds have no development origin or development switch.

Saved grants for unconfigured services remain visible as unavailable for local
removal. They cannot authorize a session, synchronize policy, register push or
contact that service, including for revocation. Removing one forgets it locally;
it does not claim an acknowledgement from the old relay. Valid configured-origin
grants retain their storage and identity; no protocol or database change is needed.
HTTP and WebSocket entry points also enforce the build's configured origins.

Approval always shows the configured host and identifies the browser name as
text supplied by the other device. Labels reject controls, invisible formatting
and Unicode line/paragraph separators while retaining ordinary Unicode names.
This prevents those label tricks; it does not authenticate the displayed name.

Verification is recorded in [App Links](app-links.md#enrollment-origin-pinning-2026-10-22).
The existing Play beta is unchanged until a new Android build is released.

## SG-3: public clients can exhaust durable relay enrollment state

The accountless relay lets a client create both endpoints and complete a
cryptographically valid pairing without access to a victim. Pending requests
are bounded, but completed and revoked pair records share a fixed durable cap.
They survive restart and count against the cap indefinitely under the current
protocol. On 2026-10-22, the Node relay moved pairing/policy/tombstone and push
state to SQLite row writes, preserving existing grants through a one-time import.
Pairing starts have a separate 10/IP/minute budget; completed pairings share a
persistent rolling limit of 100/hour and the existing 10,000 lifetime cap.
Admission is rechecked after asynchronous verification. There are at most 64
unauthenticated sockets and one authenticated management socket per pairing.
See [the bounded relay hardening](relay-storage.md).

This is deliberately a small development/self-hosting investment. A distributed
client can still consume the completion budget or eventually fill the durable
cap and deny new enrollment. Existing grants remain usable at capacity; no
pairings or tombstones are silently expired. SQLite removes whole-file rewrite
amplification, not accountless enrollment abuse.

The isolated Cloudflare backend now uses a bounded admission directory before
pairing-object allocation, durable request/upgrade and socket-lease budgets, and
receive-credit bounds across hibernation. These contain staging growth while
its fixture gate stays closed; they do not resolve anonymous enrollment fairness
or authorize public exposure. See [Cloudflare limits and tests](cloudflare-hardening.md).

Before broader public use, move this state to storage with bounded mutation
cost, set defensible lifecycle and capacity rules, apply edge and per-principal
quotas where a meaningful principal exists, and alert on growth and rejection
rates. An IP rate limit alone is not a distributed-abuse defense. Revoked IDs
cannot simply be forgotten: tombstone retention and any compaction scheme must
preserve the rule that rollback or reuse never restores authority.

## SG-4: FCM wake precedes the end-to-end application handshake

This ordering is necessary when the phone process is absent, but it does not
mean that knowing a pairing ID is enough to wake a victim phone. The sequence
is:

1. The viewer opens a relay route for a pairing ID.
2. The relay supplies a fresh, short-lived challenge.
3. The viewer signs the relay origin, pairing ID, role and challenge with the
   viewer key pinned during pairing.
4. Only after verifying that signature may the relay queue an FCM hint if the
   phone is absent.
5. The phone checks the local pairing and access generation, then requires the
   endpoint-authenticated, end-to-end encrypted session before accepting a
   control command.

A random party with only the pairing ID cannot trigger that wake path. An
authorized or compromised viewer key can request repeated wakes, and a
compromised relay can originate hints because it holds the push registration.
Neither condition gives the relay the phone or viewer endpoint key needed to
complete the encrypted control handshake. Separately, an attacker can create
its own valid pairings and consume a shared FCM send quota, but those records
point to attacker-controlled registrations rather than a victim phone.

The remaining gap is availability and nuisance-abuse control: use fair quotas,
cooldowns and monitoring so one pairing or self-enrolled client cannot consume
the service-wide wake budget. Moving FCM after the application handshake is not
a solution because the wake hint exists to make that handshake possible.

## SG-5: pairing again is not revocation

Owner decision, 2026-10-22: keep independent pairings and allow stale entries.
No coordinated replacement transaction is required. The phone remains the
authority for whether a paired device can control it.

- **Pairing adds access.** A new pairing leaves earlier phone permissions
  unchanged. The browser can update its local card to use the new grant while
  preserving its name and history. Both the QR page and native approval explain
  that earlier permissions remain enabled until removed in Devices on the phone.
- **Remove on the phone.** Persistently block that grant locally, invalidate
  its generation and end affected sessions immediately. Notify the relay best
  effort. Failed cleanup retains an already-blocked record; Devices shows
  pending cleanup and offers Retry cleanup. Service availability never determines
  whether the local removal took effect.
- **Forget in the browser.** Delete the local card and close its sessions.
  This does not revoke the phone's permission. The confirmation directs the
  owner to remove that old entry on the phone to stop its access. A browser
  entry left after phone-side removal can simply be forgotten.
- **Unconfirmed pairing.** An interrupted final receipt can leave a stale entry
  on either side. Show that pairing was not confirmed and ask the owner to check
  Devices before trying again. Once the browser has submitted completion, an
  error stops automatic QR renewal even if the code expired while awaiting the
  response. Another code is an explicit user action and still adds access.

An old enabled grant remains usable by a browser that retains its key and grant;
age and appearance do not revoke it. Once the phone has removed the grant,
leftover relay/browser records cannot restore phone authority. Lost browser
storage is handled by removing the old device entry on the phone and pairing
the browser anew. Relay tombstone and backup rules remain unchanged.

This changes product copy and cleanup visibility while preserving the existing
local-revocation and best-effort synchronization mechanism. No wire format or
database change is required. Source verification is recorded in
[mobile management](mobile-management.md#independent-pairings-and-stale-entries-2026-10-22);
delivery in the Android app and hosted viewer remains separate.

## SG-6: the hosted viewer origin is an endpoint

The browser's private key is non-exportable, but JavaScript running at the same
origin can use it and can observe control input, including a PIN entered into
the viewer. Compromise of the hosted viewer, its deployment credentials or its
supply chain is therefore endpoint compromise, not merely relay compromise.
Strict content security policy, dependency review, narrowly held deployment
authority and reproducible immutable releases belong in the endpoint threat
model.

## SG-7: enable HSTS

Enabled and live-tested 2026-10-22. HTTPS responses from `yepcontrol.com` and the
separate `www.yepcontrol.com` redirect host send exactly one
`Strict-Transport-Security: max-age=31536000` header (one year). Each policy
covers its own hostname. Neither `includeSubDomains` nor `preload` is enabled;
other subdomains carry no commitment from these policies.

The deployment first used a five-minute lifetime and verified it before applying
the one-year policy. Public HTTPS GET checks pass for the viewer and its scripts,
privacy page, enrollment/install page, App Links association file, relay health,
API errors, a missing association file and the `www` redirect. The redirect
preserves the path and query. On-host HTTP checks confirm the existing 308
redirects to HTTPS for both names, without an HSTS header on plain HTTP.
Configuration validation passed, unrelated ingress configuration was preserved,
and relay health and the running product revision were unchanged. No Android
release or product-service deployment is needed for this fix.

HSTS protects clients after they have received the policy over HTTPS. The first
HTTP visit remains outside that protection; browser preload is a separate
decision. Broader subdomain coverage requires confirming that every covered
subdomain will remain HTTPS-only. Private verification receipts stay in
`.local/sg7-proof/`.

Official Caddy documentation and browser documentation reviewed 2026-10-22:
[Caddy response headers](https://caddyserver.com/docs/caddyfile/directives/header)
and [HSTS behavior](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Strict-Transport-Security).

## Lower-priority hardening

- Return a purpose-built public enrollment-status projection instead of the
  relay's complete stored pair object. Pairing IDs are high entropy and the
  exposed policy fields do not grant authority, but the public response should
  disclose only what enrollment and tombstone checks require.
- Resolve the current production dependency audit advisory for the transitive
  `uuid@9.0.1` when its dependency chain permits it. No use of the advisory's
  affected API was identified in this review.

## Review result and release gate

No practical break was found in the reviewed transcript signatures, P-256
ephemeral key agreement, HKDF key separation, directional AES-GCM framing,
sequence checks or endpoint key pinning. That is a limited source-review result,
not a cryptographic proof. The SG-2 and SG-5 fixes must reach the distributed app
and viewer, SG-3 needs an explicit public-service policy before wider release,
and the complete protocol and hosted endpoint should receive an independent
security review.
SG-7 is enabled and verified on the current deployment.
