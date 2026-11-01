# Phone-local ADB: physical Moto investigation

Review/test date: 2026-11-01. Device: Moto G Power (2022), Android 12 / API 31,
with no secure screen credential. The owner requested this physical follow-up
to the [isolated emulator experiment](../experiments/local-adb/README.md).

**Status: partial physical acceptance.** Phone-local pairing, the optional
settings self-grant, attested helper input and one repaired reboot passed.
Unattended reboot recovery failed on this firmware. The second reboot lost
the controller's ADB transport; outage checks and device cleanup are pending
reconnection. The temporary spike APKs and their new pairing remain installed.
No production release or installed YepControl upgrade was performed.

## What passed on the phone

- A fresh, independently installed `com.yepcontrol.adbspike` starts off, without
  pairing or `WRITE_SECURE_SETTINGS` authority.
- Android's on-phone pairing dialog supplied its code to the app notification's
  RemoteInput route. The embedded client paired with this phone's own listener.
  The controller issued neither `adb pair` nor a privileged permission grant.
- Manual advanced mode reached Ready without the settings grant. Android
  Binder attested the helper as UID 2000. An ordinary app caller was rejected
  even when it supplied the correct bootstrap secret.
- Checking automatic restoration separately caused the phone-local client to
  grant its own settings permission. The existing helper was retained.
- The helper queried the fixture and delivered a tap, independently verified
  by the native button counter. Android 12 predates the sensitive-view flag
  and the newer gesture filter; this is **not** physical qualification of the
  original Pixel/Maps sensitive-screen case. The temporary comparison
  accessibility service was not enabled on this older OS.
- After the first reboot, the app restarted itself, retained the same identity
  and settings grant, and recorded three of its own requests to enable the
  listener. Its resident service did not need its activity to be opened.
- A single operator-equivalent approval of Android's pending network dialog
  restored the existing app process and saved pairing in **12.28 seconds**,
  including harness/helper startup. Subsequent helper input passed. No app
  launch, re-pairing or new grant was needed after the approval.

The controller supplied installation, observations and UI test actions. The
network-approval test used a one-shot native UI harness while leaving the app's
service alive. It required the real SystemUI dialog, exact controls and the
same access-point BSSID as preflight, compared without retaining it publicly.
This demonstrates the on-phone repair operation, not a manual usability study
or USB-free end-to-end acceptance.

## A real discovery defect, now fixed

The clean physical run initially paired but could not find its connection
listener. Instrumented discovery showed one foreign LAN service resolving
first and the other requests failing with error 3, `FAILURE_ALREADY_ACTIVE`.
Android 12 allows one outstanding resolution per `NsdManager`. The previous
parallel resolve calls discarded the phone's own advertisement.

The experiment now serializes resolutions, bounds retries and candidate count,
and cancels queued work on close. It still verifies that the advertised address
belongs to this phone and connects only through loopback. Diagnostics report
error codes and local/nonlocal results, not addresses or host names.

The diagnostic installation and only its pairing key were removed, with the
original ADB key set verified unchanged. A second clean installation then
passed the entire phone-local setup/self-grant/input sequence with the fix.
The final owned API-36 regression also passed after the discovery change,
including three automatic reboots (**27.93, 27.96, 27.74 seconds**), outage
recovery, orphan expiry and the off-state check. Android build/lint and relative
documentation-link checks passed.

## Why the first reboot was not unattended

Android left Wireless debugging off and displayed **Allow wireless debugging
on this network?** despite the earlier remembered approval. The system log
reported twice:

```text
AdbDebuggingManager: Expected keyStore, but got tag=adbKey
```

This matches the Android-12 trusted-network loader defect already documented
in the [sibling spike's source review and physical qualification](sibling-repositories.md#android-device-access-spike-adb-availability-and-recovery).
Its [architecture record](https://github.com/kzahel/android-device-access-spike/blob/e7c42adb888b037ee6b64589e6a100f2e89d0ff3/docs/architecture.md)
distinguishes requesting the listener from approving its network. The grant
and stored client identity survived; system network approval was the missing
step. An app settings grant does not repair that parser.

This phone also has the older spike's accessibility approval adapter installed.
Its fresh same-boot receipt reported `disabled`, `attempted=false` and
`allowActionAccepted=false` throughout this proof. It did not provide hidden
approval assistance to the new app.

The new experiment does not automatically accept network prompts. The older
spike's explicitly enrolled, exact-network accessibility handler is a separate
qualified workaround on its fixture; importing or integrating that behavior
is outside this physical check. No sibling code or private enrollment was copied.

## Second reboot and pending cleanup

The next ordinary reboot timed out waiting for ADB. macOS I/O Registry still
identified the selected Moto and its ADB USB interface, but the shared SDK
server no longer listed its transport. Targeted attach and isolated SDK
servers restricted to that one phone, using both USB backends, did not recover
it. Other phone transports remained available. No shared ADB-server reset,
lock change, key revocation or other-device operation was attempted. The
isolated witness servers were stopped afterward.

This does not establish that Android failed to boot or that the app caused
the USB failure. Physical display/connection confirmation was requested.
The remaining Wi-Fi/listener/lease tests, off-state reboot and cleanup cannot
be marked passed from the available observations.

On reconnection, finish those bounded checks, turn the experiment off, forget
only `YepControl-local-spike` through Android's UI, uninstall its two APKs,
restore the initial Wireless debugging switch, and compare the original ADB
key set, installed packages and enabled accessibility services. Existing
YepControl 0.9.0 and the two older access fixtures must be retained.

Private selectors, controller scripts, raw logs, baselines and receipts remain
under ignored `.local/local-adb-moto/`.

## Recommendation

Keep native phone-local ADB as the candidate for a separate, default-off
Advanced screen. This phone confirms provisioning can be performed by the app;
it does not support an unconditional no-touch-reboot promise on this firmware.
Expose a clear **Approval required on phone** repair state alongside Ready
and Wi-Fi required. Keep ordinary control available independently.

If unattended recovery on this firmware is required, separately qualify a
strictly opted-in, exact-network approval handler using the existing
accessibility service. Preserve first-unlock, unknown-network, grant, input
switch and existing browser-authority boundaries. The new discovery fix does
not replace that missing approval step, and physical qualification is not
complete until the interrupted checks and cleanup are finished.
