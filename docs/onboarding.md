# Pairing roles and scanner feedback

Owner-reported usability problems, 2026-10-25: a phone owner showed the app's
website QR to another person, expecting their browser to gain control. That QR
only opened the public homepage, which emphasized installation. Both products
used generic Add phone/device language, and opening the native scanner had no
pending state. The owner clarified that the website must still support people
who want to install the app and make the current phone available for control.

## Roles and entry points

The website exposes both purposes: **Control another phone** (this browser,
without an app on the controlling device), and **Let this phone be controlled**
(the Android app, with a prominent public Play badge and setup instructions).
The browser's pairing action is **Control a phone**. The native app says
**This phone**, **Allowed browsers** and **Allow a browser**. Paired phone
inventories, browser identities and native permissions remain unchanged.

Pairing continues to use the existing compatible v1 flow: the controlling
browser creates an invitation; the Android phone being controlled receives it
and explicitly chooses **Allow**. A website/browser-setup QR is navigation, not
authority. Native copy/share/QR tools now open `/pair` directly and visibly
explain that the app then scans the code shown in that browser. No reverse
pairing protocol or automatic permission grant is introduced.

The browser also provides **Copy pairing link instead**. This is the same
short-lived `/enroll#...` App Link as its QR, copied only on a user action, for
delivery to the phone's owner. Clipboard failure provides a selectable link.
The phone's normal origin/expiry checks and Allow screen still apply.

If that invitation opens in a browser, the install guide clears the fragment
from history and retains a valid invitation only in page memory for an explicit
**Open pairing in YepControl** action. The Android intent pins the app package,
retains the original invitation and uses a fixed public Play fallback with no
pairing material. Invalid, foreign-service and expired links do not get an app
handoff action. Hash navigation to a second link is processed and scrubbed too.
No analytics, remote command channel, origin migration or deferred installation
pairing is added. After installation, use a fresh link or code.

## Scanner startup

The app renders an Opening scanner progress state immediately and admits one
scanner task. Its ViewModel retains that task across activity recreation.
Cancellation and failure release the pending state; a result after navigating
away cannot open approval. It clears completed task references without saving
scanned secrets in activity state. The scanner remains managed by Google Play
services; no app camera permission is added.

The manifest requests the documented `barcode_ui` install-time module download.
The API is otherwise unbundled and can download its module on first use. After
a short wait, the UI explains that Android may be preparing/downloading it.
This is a plausible source of the reported first-use delay, not a timed trace
of the owner's attempt or a guarantee that every scanner launch is immediate.

Official sources reviewed 2026-10-25:

- [Google code scanner: install-time downloads and task outcomes](https://developers.google.com/ml-kit/vision/barcode-scanning/code-scanner).
- [ML Kit scanner cancellation code](https://developers.google.com/android/reference/com/google/mlkit/common/MlKitException#CODE_SCANNER_CANCELLED).
- [Chrome Android intents: explicit user gesture, package and public fallback](https://developer.chrome.com/docs/android/intents).

## Verification

Built-site Chromium checks cover both roles, rendered QR decoding, copied-link
identity, clipboard failure, valid app handoff, fragment scrubbing including a
second same-document link, and the public-only Play destination. TypeScript
coverage rejects wrong-origin, malformed and expired app handoffs.

The owned-emulator native navigation test injects a pending scanner task to
verify immediate visible progress, duplicate-tap suppression, recreation,
failure/retry, normal cancellation, ignored late results and the actual approval
screen. This is deterministic UI/lifecycle evidence, not a physical-camera or
first-download timing test. Native enrollment tests round-trip the complete
intent through Android's real parser and retain the existing pinned service
validation. Existing native local-settings protection tests pass.

Hosted signed pairing/Allow, encrypted exchange, process-absent FCM, persisted
reconnect and revocation pass with the candidate viewer and an owned Android 15
emulator against the production relay. The broader native-management run also
decoded the app's website QR as `/pair`, paired two independent browsers and
passed their encrypted foreground checks. That run later failed its notification
permission restoration check: Android reported notifications allowed, but both
pair records still reported wake readiness false. It is not a passing full
multi-browser/background-recovery qualification. No wake implementation was
changed by this work. Its fixture now parks inactive viewers to release prepared
sessions, rather than assuming the earlier one-shot readiness behavior.

The source at `95320ee` passed complete
[Checks](https://github.com/kzahel/yepcontrol/actions/runs/40234299551).
The website is live as `relay-v0.2.1`; fresh isolated mobile and desktop checks
against the public origin verify both roles, QR decoding and the invitation
handoff. See [the deployment receipt](relay-releases.md#pairing-roles-and-links--2026-10-25).
New scanner UI and its
install-time module request need an Android update; website improvements also
work with the existing public 0.7.0 and internal 0.8.0 apps.

Internal **0.8.1/code 7** was installed through Google Play on the Pixel 7a.
A fresh pairing first opened through Chrome's explicit app handoff in the older
0.8.0 app and reached browser readiness. That pairing and the native permissions
survived the update; the browser connected and its Home action was independently
confirmed in Android's focused window. The real Google scanner opened, but
closing it exposed a misleading failure notice. Play services can return
`MlKitException.CODE_SCANNER_CANCELLED` rather than a cancelled Task. Code 7
was not promoted publicly.

The **0.8.2/code 8** candidate treats that documented result as normal
cancellation, with an added native UI regression check. It retains the same
signing identity and storage/protocol contracts. Release and physical receipts
are recorded separately when established.
