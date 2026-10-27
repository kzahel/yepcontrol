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

## Play-installed smoke check — 2026-10-25

The attached Pixel 7a now passes basic computer-browser viewing/navigation,
background wake/reconnect and consented smooth video using Play-installed
**0.7.0/code 5**, with the expected Play signer and installer. This account is
enrolled in internal testing, so this checks the same promoted binary through
Play rather than independently proving production-track delivery. The run also
reproduces an avoidable roughly 30-second check-to-control wait. See the
[timings, cause and qualification limits](../connection-delay.md). This does
not replace natural overnight, physical credential/reboot or broader acceptance.

## Android 0.8.0 production preparation — 2026-10-25

The owner authorized autonomous production deployment and publication after
physical acceptance. The source, signed AAB hash and internal publication
receipts are in [the 0.8.0 beta record](android-beta.md#android-080--code-6--2026-10-25).
The attached Pixel 7a received **0.8.0/code 6 through Google Play** as an in-place
update and passed [prepared-session and control acceptance](../connection-delay.md#production-and-play-installed-acceptance--2026-10-25)
against the new production relay. Pairing and native grants survived the update.

The exact internal code-6 bundle was promoted into a production release draft,
with **100% rollout / all targeted countries**, the connection-improvement notes
and no supported-device losses. Console reported only the existing nonblocking
missing deobfuscation/native-symbol warnings. The rollout was saved to Publishing
overview; managed publishing remains off. Automated quick checks completed and
Console displayed **Your changes can now be sent for review**.

At **18:54 UTC**, the final **Send changes for review** confirmation repeatedly
closed without an error or a submission receipt. A fresh tab and native browser
input did not change the persisted result: **Changes not yet submitted for
review / Production / 0.8.0 / Start full rollout**. Submission activity still
contained only the earlier published 0.7.0 submission. The owner was asked to
try the ready final control; the tested release remains saved.
**Production submission, Google approval and public availability of 0.8.0 are
not yet established.** Internal 0.8.0 and the production website/relay are live.

No signing keys, service-account permissions, Console declarations, store
listing or CI publication track were changed for this promotion. Private
screenshots and release receipts remain in ignored `.local/prepared-release/`.

### Later availability confirmation — 2026-10-26

Console Submission activity now records **Submission 2 / Production / 0.8.0 /
Published**, submitted **Oct 25 at 22:33 local** and published at **22:44 local**.
Its recorded source is **API**. This supersedes the earlier unsubmitted status
above. That submission minute matches the later code-7 internal publication;
the internal publisher used an app-wide commit with review submission enabled,
which can include production changes already staged in Console. The code-6
public rollout had already been authorized and physically accepted. Code 7
itself was not the production artifact in that submission.

The internal publisher now explicitly requests `changesNotSentForReview=true`
and retains `changesInReviewBehavior=ERROR_IF_IN_REVIEW`, without a fallback to
review submission. It still writes only the internal track and reports
`internal_committed` / `reviewRequested: false`. Thirteen publishing regressions
pass, including a pending-production-track fixture. This change has not been
used for a live new internal release yet; a server refusal must fail closed.
It is not used as a workaround for submitting the prepared production rollout.
See [Google's app-edit commit contract](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit).

## Android 0.8.3 production preparation — 2026-10-26

The exact signed **0.8.3/code-9** internal candidate has passed Play-installed
Pixel 7a acceptance, including preserved pairing/permissions, browser control,
an independently observed remote Home action and real scanner Back/Close/retry.
Its signing and internal-delivery provenance are in
[the beta receipt](android-beta.md#android-083--code-9--2026-10-26).
The temporary test pairing is revoked, its browser refuses access and has
exited, and media projection is null.

Console promoted that already-uploaded code-9 bundle to a production draft,
with the now-published code-6 release as its predecessor. The saved release selects
**100% rollout / all targeted countries**, has no supported-device losses and
shows only the existing missing deobfuscation/native-symbol warnings. Its notes
cover clearer two-device setup, QR/link pairing, scanner feedback and faster
reconnects. Listing, declarations, signing identity and CI publication permissions
remain unchanged; the CI publisher is still internal-only.

Console confirmed **Your change has been saved** and directed the owner to
Publishing overview for the separate final review submission. Saving does not
establish submission, approval or public availability of 0.8.3.

### Final review submission remains unconfirmed

Quick checks completed and Console displayed **Your changes can now be sent for
review**. The final **Send changes for review** confirmation closed without an
error or a submission receipt using the semantic control, a screenshot-based
click and the focused keyboard control. A fresh page still showed **Changes
not yet submitted for review / Production / 0.8.3 / Start full rollout**.
Submission activity showed only the published 0.7.0 and 0.8.0 submissions.
No sign-in challenge was open. The tested code-9 rollout remains saved and ready
in the owner's Publishing overview; its final control needs an owner UI attempt.
This is an observed Console submission blocker, not a request for new publication
authorization. No API commit is used to submit it indirectly.

## Android 0.9.0 production preparation — 2026-10-26

The owner authorized autonomous phone-first pairing implementation, end-to-end
verification, website deployment and Play publication. Android **0.9.0/code 10**
passes [release and Play-installed physical acceptance](android-beta.md#android-090--code-10--2026-10-26),
including preserved access, real browser control and protected QR creation. The
matching [website/relay](../phone-first-pairing.md#production-website-and-relay--2026-10-26)
is live. The exact accepted internal bundle was promoted in Console into a new
production release, replacing the earlier unsent 0.8.3 candidate.

The saved release selects **100% rollout / all existing targeted countries**,
has no supported-device losses and only the existing deobfuscation/native-symbol
warnings. Notes describe phone-issued QR pairing, retained browser-first pairing,
clearer setup/scanner feedback and faster reconnects. Listing, declarations,
signing identity, account permissions and CI publication scope are unchanged.
Managed publishing remains off.

Console confirmed the change was saved and quick checks completed. The final
**Send changes for review** confirmation repeatedly closed without an error or
submission receipt through semantic, native accessibility and focused native
keyboard controls, including a foreground window and fresh page load. The
persisted result remains **Changes not yet submitted for review / Production /
0.9.0 / Start full rollout**. Submission activity still contains only the earlier
published 0.7.0 and 0.8.0 submissions. Browser error logs contain no reported error;
no sign-in challenge is open.

The tested rollout is saved and ready in the owner's Publishing overview; the
final confirmation needs an owner UI attempt. This is a Console submission
blocker, not a request for new publication authorization. No API commit requests
production review indirectly. **Production submission, Google approval and public
availability of 0.9.0 are not established.** Internal Play 0.9.0 and the production
website/relay are live. Private Console receipts remain in
`.local/phone-first-release/`.

### Production review submitted — 2026-10-27

After the owner's renewed publication instruction, the final Console
confirmation succeeded. Publishing overview now displays **Changes in review**,
**Your changes are now in review**, and **Production / 0.9.0 / Start full rollout**.
This supersedes the unconfirmed submission status recorded above.

The accepted **0.9.0/code-10** bundle is submitted for **100% production rollout**
across the existing targeted countries. Managed publishing remains **off**, so
the rollout can publish automatically after Google approval. Submission is
confirmed; Google approval and public availability of 0.9.0 remain pending.
The website/relay is already live. The private Console screenshot is
`.local/phone-first-release/production-submitted-20261027.jpg`.
