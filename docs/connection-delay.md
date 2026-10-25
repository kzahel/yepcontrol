# Connection waiting-screen investigation — 2026-10-25

The owner reported that control eventually worked after a long wait showing
“Waiting a moment before contacting your phone again…”. The supplied screenshot
names Pixel 9; the attached test device is Pixel 7a. The original session has no
captured timing trace, so its exact duration is unknown. The same message and
unknown capability icons were reproduced on the attached phone.

## Published-build evidence

Installed YepControl through the phone's Google Play app, without replacing it
with a locally built APK or installing instrumentation. Package manager reports
`com.yepcontrol.app`, installer `com.android.vending`, version **0.7.0/code 5**,
and no debuggable flag. The installed signing certificate matches the website's
Play association. This Google account is enrolled in internal testing, and Play
labels its listing accordingly; the installed version/code is the same candidate
promoted to public production. This does not prove signed-out production-track
delivery on a separate account.

An isolated Playwright Chromium on the computer paired through the production
website and the normal native Allow screen, using the invitation's App Link.
Normal disclosure/accessibility and notification consent enabled viewing, input
and background requests. Actual browser Home moved the phone from YepControl to
its launcher, independently witnessed with activity-manager state and a rendered
browser capture. Screen images rendered at 1080×2400. Smooth view, after normal
Android screen-sharing consent, rendered seven decoded VideoFrames in a
three-second sample; Android independently reported the active projection.
This is a smoke check, not a frame-rate benchmark or full physical qualification.

The production health response identifies relay **0.1.3**, source
`ec92ad56f903ad1598eb0c8dcd922c92c59fa4a5`, deployment
`803d8a00-32de-410c-bf81-d308ccbadd6e`, with public admission.

## Reproduced delay

With YepControl in the background, reloading the saved phone page automatically
checks the connection. The browser records these relative times from one run:

| Event | Time |
| --- | ---: |
| Check WebSocket opened | 133.519 s |
| Check authenticated | 133.645 s |
| First wake accepted by Firebase | 134.152 s |
| Phone route ready for the check | 134.848 s |
| Check socket closed | 135.151 s |
| Immediate Connect socket opened | 135.219 s |
| Connect authenticated | 135.345 s |
| Relay reports `contacting/coalesced` | 135.362 s |
| Queued second wake accepted | 163.796 s |
| Phone route ready for control | 164.738 s |

The initial check needed **1.329 s** from socket opening to phone readiness.
The control connection then needed **29.519 s**, including **28.434 s** displaying
the cooldown status and **0.942 s** from the second acceptance to phone readiness.
These are browser-observed route timings; `accepted` is not a phone-delivery
receipt, and `ready` precedes the encrypted handshake/first screen.

A second run pressed Connect **300 ms into the automatic check**. It canceled
that check, replaced its wake request and showed the exact reported status with
all three capability icons unknown. The new socket opened at 274.983 s, received
`coalesced` at 275.139 s, and became ready at 305.874 s: **30.891 s** total. Thus a
user need not finish a check or deliberately retry to encounter the delay.

## Cause

1. `web/src/phone-page.tsx` automatically calls `start("check")` when a phone page
   opens, and on a restored browser page. This can wake a background phone.
2. `encryptedCheck` in `web/src/relay.ts` closes that session after its canary and
   feature report. Connect calls `start("control")`, which closes any pending
   check and opens a new socket. The button remains enabled during checking.
3. Each new viewer socket gets a fresh request ID. The background Android worker
   connects for that specific request; an old hint cannot satisfy the new one.
4. The Cloudflare Pairing object's `attemptWake` retains a **30,000 ms per-pair
   cooldown**, including after a successful check or an abandoned request.
   During it, the second request is queued for the Durable Object alarm and
   reports `delivery: "coalesced"`. The viewer maps only that response to the
   reported waiting message. The Node relay has the same cooldown and scheduling.

This is an avoidable interaction between the viewer's two-session flow and wake
throttling. The measured wait occurs before encrypted screen control or WebRTC
setup. The phone responded promptly when the second wake was finally sent.
It is not evidence that every delayed connection has this cause: initial FCM
delivery, Android scheduling and network availability remain separate limits.
The screenshot's last-contact label is saved history, not proof that the current
control session has reached the phone.

## Follow-up, not implemented

The smallest viewer-only remedy compatible with installed 0.7.0 hosts is to stop
automatically waking/checking a phone immediately before an explicit Connect.
One Connect action would make one wake request. If automatic readiness checks
remain a product requirement, design a single retained session that can become
control; the current Android canary/check path tears down and cannot simply be
held open indefinitely by changing the viewer. Preserve fresh request binding
and bounded wake budgets. A countdown would explain the wait but would not
remove it. Merely disabling Connect until the check completes also retains the
reproduced check-then-connect delay.

Existing Node regression coverage explicitly verifies delayed fresh delivery
after rapid check-to-control reconnect. The viewer status test verifies the
cooldown message. These check eventual recovery, not acceptable connection
latency. A remedy needs acceptance covering both clicking during the initial
check and connecting immediately after it, against an installed 0.7.0 host.

Private timings, browser state, APK/signing evidence and captures stay in ignored
`.local/play-delay-investigation/`. No physical credentials, lock/debugging or
network settings were changed. Other apps and accessibility services were
preserved. UI hierarchy dumps were used for local setup, but avoided during the
final smooth-view check because UI automation temporarily interrupts accessibility.
No product code or production deployment changed in this investigation.

The temporary browser pairing was removed on the phone, screen sharing stopped,
and the isolated browser exited. The Play-installed app and its normal setup
remain on the phone. The targeted viewer-status and Node rapid-reconnect
regressions pass (three tests) under Node 24; `git diff --check` also passes.
