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
emulator against the production relay. Additional multi-browser/native shortcut
and publication receipts are recorded when completed. New scanner UI and its
install-time module request need an Android update; website improvements also
work with the existing public 0.7.0 and internal 0.8.0 apps.

The Android candidate is **0.8.1/code 7**, using the existing signing identity and
storage/protocol contracts. This source record does not establish Play delivery,
physical acceptance or production availability of that update.
