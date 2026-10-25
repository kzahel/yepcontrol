# First production Play release

Requested by the owner on 2026-10-23. The existing signed **0.7.0 / code 5**
bundle was promoted from Play's library; no new app binary or signing key was needed.
The internal build/signing run is `39844787724`, source
`b87030528328ee517719fadcaaa90c8300f327c4`, AAB SHA-256
`a12bd1369ce92b5c86fdd457f8ec1deaa413dd09dcd3695d2d703e12b923a134`.

Console enables production release creation on this account. No mandatory
closed-test production-access gate was observed. The submitted release selects
all 177 listed countries/regions plus Rest of World (178 targets). Store choices
remain free, Tools, no ads/account, and intended age 13+. Existing listing,
Data safety, privacy, content rating and reviewer pairing instructions accompany
the release. Managed publishing is off; after Google approval, the release can
publish automatically. Submission does not establish public availability.

The existing WIF CI publisher remains limited to internal testing and retains its
app-scoped testing-only permission. First production promotion uses the owner's
Play Console session and the exact already-uploaded bundle. Do not silently
broaden the CI publisher's permissions or switch its default track.

Accessibility declaration: App functionality only, not an accessibility tool;
full prominent disclosure/decline/reopen/agreement/Android-grant demonstration.
The API-specific collection/sharing answer uses the linked Data safety definition:
local-only PIN processing and end-to-end encrypted screen/input content are
outside reportable collection. This does not deny that Accessibility accesses
sensitive screen content, which the native disclosure explicitly describes.
Relay pairing identifiers and optional Firebase delivery identifiers remain
separately declared in Data safety; they do not come from the Accessibility API.

Foreground services: MEDIA_PROJECTION for screen-content streaming, SPECIAL_USE
for an authenticated user-requested remote session with an ongoing Disconnect
notification. The declaration describes immediate interactive response, clean
disconnect/timeout, and interruption of encrypted viewing/input if deferred or
restarted. The updated demo shows normal Android projection consent, actual
decoded video and the visible session/Disconnect notification.

Nonblocking Console warnings for code 5 concern missing deobfuscation/native
symbol uploads; no target-SDK, ABI, signature or 16-KiB blocker was reported.

Sources checked 2026-10-23:

- https://support.google.com/googleplay/android-developer/answer/9859348
- https://support.google.com/googleplay/android-developer/answer/10964491
- https://support.google.com/googleplay/android-developer/answer/13392821
- https://support.google.com/googleplay/android-developer/answer/10787469

## Submission — 2026-10-23

The owner authorized public Play publication. At **05:27 UTC**, Console accepted
**Send changes for review** for the eleven pending changes and displayed
**Changes in review**, including production **0.7.0 / Start full rollout**.
Automated quick checks were still running; Console says the changes are sent to
review when those checks succeed. There was no remaining advertising-ID blocker:
the saved answer is **No**, consistent with the app's permissions and SDKs.

**This is a submission, not Google approval or public store availability.**
Managed publishing is off, so approved changes are set to publish automatically.
Check Publishing overview and the public listing before announcing availability.
No app binary, signing key, CI release permissions or default publication track
changed for this promotion. Play-installed physical acceptance and natural
unplugged overnight/reboot qualification remain separate.

## Reviewer demonstration

Both Accessibility and foreground-service declarations link the
[140-second demonstration](https://github.com/kzahel/yepcontrol/releases/download/play-review-v0.7.0/yepcontrol-play-review.mp4).
It was recorded on an owned Android 15 emulator and an isolated browser against
the hosted relay. The debug app's functional source matches the signed candidate;
this recording does not establish Play-installed physical acceptance.

The recording shows disclosure decline and agreement, normal Android accessibility
grant, paired browser viewing and navigation, normal screen-sharing consent,
actual smooth video (42 decoded frames), the ongoing Disconnect notification,
and disconnect. Its fixture was revoked and the emulator/browser reaped. The
public anonymous download matches SHA-256
`b9be0ae736a87f1a82bf34cf1a019e8f797405b6338a6f30d3f50d2ef5ea7029`;
full H.264 decode passed. The media-only prerelease is not an app distribution.

Android 15 hides notification content during screen sharing. The demonstration
therefore stops smooth sharing before showing the readable session notification;
it does not disable Android's protection. See
[Android's screen-sharing protections](https://developer.android.com/about/versions/15/behavior-changes-all#screen-share-protections).

## Follow-up

After review, verify the production release is available in Console and the public
listing opens without tester enrollment. Preserve any policy feedback and address
it before submitting another candidate. Run a Play-installed acceptance check within existing
device authorization; emulator/debug evidence does not substitute for that check.

## Public availability — 2026-10-25

The owner reported Google approval. An anonymous HTTPS fetch of the
[public listing](https://play.google.com/store/apps/details?id=com.yepcontrol.app&hl=en&gl=US)
confirms **YepControl – Remote Phone**, developer **Graehl Arts**, **Install**,
Tools, Everyone / Users Interact, and the first-public-release notes. The store
shows an update date of Oct 23, 2026. No tester enrollment or Google sign-in is
needed to view the listing. This establishes public availability; the exact
review-completion time was not inspected in Console. The promoted candidate
remains the existing signed 0.7.0/code-5 bundle above. Play-installed physical
acceptance and natural overnight qualification remain separate.
