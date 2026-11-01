# Advanced control components

Reviewed 2026-11-01. This is an optional native client and a restricted shell-UID
input helper, not a bundled ADB executable/server, PRoot or Shizuku installation.
Only Android's own pairing and phone-local ADB authentication bootstrap it.

## Distributed components

- [libadb-android 3.1.1](https://github.com/MuntashirAkon/libadb-android/tree/c849886ebc6d48e7b46d967e78a6bb65c90c3b74),
  source revision `c849886ebc6d48e7b46d967e78a6bb65c90c3b74`.
  Elect **Apache-2.0** from its dual GPL-3.0-or-later OR Apache-2.0 offer.
  Its pairing connection is source-vendored under the elected Apache license
  with bounded loopback sockets, cancellation, null-safe cleanup and the public
  Conscrypt exporter. The component's Apache, BSD-3-Clause, MIT and COPYING notices are included in
  the app's `assets/third-party`. Its transitive **spake2-android is excluded**.
- YepControl's independent Java/JNI SPAKE2 adapter: MIT, this repository.
  It implements the ADB client's small pairing interface using upstream
  BoringSSL functions. No implementation from the LGPL spake2-java / spake2-c
  projects is copied or linked. SPAKE2/HKDF/GCM are not reimplemented here.
- [BoringSSL Android prefab 20251124](https://github.com/vvb2060/BoringSSL_Android/tree/bb1b6bf9f1e1b28f19ef1f036e6b140d980cdd11),
  wrapper source `bb1b6bf9f1e1b28f19ef1f036e6b140d980cdd11`; its pinned upstream
  [BoringSSL source](https://github.com/google/boringssl/tree/79048f1f1d8e6b7f9ca59b95c24486c8149122a4)
  is `79048f1f1d8e6b7f9ca59b95c24486c8149122a4`. The exact upstream aggregate
  ISC/OpenSSL/SSLeay/BSD notices are bundled. Only `crypto_static` is linked into
  the JNI adapter. New native linking uses NDK 28's 16 KiB alignment defaults.
- [Conscrypt Android 2.8.0](https://github.com/google/conscrypt/tree/2.8.0):
  Apache-2.0 with the upstream aggregate native/BoringSSL notices bundled.
  Supplies TLS 1.3 and its public key-export API; no application hidden-API
  exemption is used to reach Android's private Conscrypt implementation.
- [Bouncy Castle 1.86](https://github.com/bcgit/bc-java/tree/r1rv86):
  upstream permissive Bouncy Castle license bundled. The ADB client uses it for
  HKDF/GCM and certificate construction uses its ASN.1 types.

The dependency versions above are exact build inputs. Upstream artifacts are
resolved through Maven Central, except the Apache ADB client from its existing
restricted JitPack group. Verify the release dependency graph and native
alignment before publication. Bundling is not a claim of independent
cryptographic audit.

## Authority and lifecycle

The ADB RSA identity is encrypted by AES-GCM with an Android Keystore wrapping
key in credential-encrypted `noBackupFilesDir`. It is unavailable before first
secure unlock. Setup and ordinary identity/grants are separate. The advanced
identity is created only by explicit Start/setup and is removable independently
of existing YepControl controller pairings.

The helper has only ping, touch, cancel and stop operations. It accepts bounded
local authenticated packets; no controller-visible arbitrary shell command,
file operation, pairing key or bootstrap capability exists. The app verifies
actual shell UID 2000 through a `DUMP`-protected ContentProvider Binder call and
a fresh capability before trusting helper responses. Mutual HMAC challenges
bind each response to a request. Capability and attested PID live only in the
app process. Advertised mDNS addresses must belong to this phone, and sockets
connect only to loopback. ADB uses its pairing/authentication rather than Web
PKI; the lint exception applies only to this library's trust-manager bytecode,
not the app's HTTPS clients.

After initial setup, Start/Stop are ordinary runtime controls. Developer options
and pairing/forgetting remain on protected setup pages. The controller access,
local configuration protection, keyguard and captured
scene checks run before advanced input. Input failure never replays through
accessibility. Held touches time out in the helper and app; policy changes and
session close cancel input. Stop immediately removes readiness and requests
helper shutdown; process death leaves at most a 30-second helper lease. The
service is START_NOT_STICKY and has no boot receiver. An active start lasts at
most an hour; setup without readiness is bounded to five minutes.

Stopping does not disable Android's shared debugging listener or delete other
ADB pairings. Android's key expiry/revocation is respected: failed authentication
requires explicit setup repair, rather than disabling the OS authorization
timeout. The native approval remains Android's UI and is never automatically
clicked. Remote approval acceptance must be measured through ordinary product
control on each qualified platform; a shell/UIAutomator tap does not prove it.
