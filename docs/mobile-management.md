# Mobile access management

Owner-approved implementation plan, 2026-10-20. Keep the plain native Android
appearance and generic utility language. This slice manages the existing
pairing/encrypted-check functionality; it does not claim screen control exists.

## Behavior

- Pair multiple independently pinned browsers without replacing existing trust.
  Give each a local, editable nickname. A nickname is not authenticated identity.
- Main screen: global Remote access switch, honest readiness/session status,
  compact paired-browser list, Pair browser, Activity and Settings.
- Browser details: nickname, pairing/last-connection timestamps, Allowed switch,
  Disconnect and confirmed removal. Manual transport admission is a test-fixture
  helper, not a consumer control.
- Global Off and per-browser Disabled retain pairings, immediately invalidate
  authority, close affected sessions and cancel pending work. Re-enable locally.
  Disconnect ends only the current connection. Removal permanently revokes trust;
  failed relay cleanup remains locally blocked and can be retried.
- One phone session at a time. Connection activity is ephemeral and must not be
  confused with the persistent Allowed preference or last-connected timestamp.
- Settings: automatic connection-request/wake switch, notification repair,
  registration retry and app version. Show setup failure separately from intent.
- Room/SQLite stores browser grants/public pins, nicknames, policy and bounded
  local activity. Migrate the existing preference grant transactionally, preserving
  local revocation and wake intent. Private signing keys remain in Keystore.
- Activity records pairing, renaming, policy changes, authenticated sessions,
  successful checks, disconnects and failures. Retain at most 30 days/10,000 rows;
  no PINs, QR secrets, push addresses, screen content or arbitrary remote text.
  This is local history, not a tamper-proof audit service.

## Independent pairings and stale entries (2026-10-22)

Owner-approved simplified model: every pairing adds independent access. Reusing
the same browser identity creates another phone permission, and the browser may
show its newest grant in the existing phone card. Earlier phone permissions stay
enabled until the owner removes them. Pairing approval and the viewer explain
this explicitly; there is no coordinated replacement workflow.

Removing a device persists the existing local block and invalidates its
generation before relay synchronization. Failed cleanup leaves a blocked record,
shown on Devices as waiting for cleanup with Retry cleanup. A stale browser
entry can be forgotten there; browser forgetting closes its sessions and removes
its card without revoking phone-side permission. No protocol or storage format
changes are needed. Unconfirmed pairing directs the owner to inspect Devices
before another attempt, which adds another independent permission.

The native storage regression creates two grants for one browser identity,
verifies both remain independently enabled, removes one without acknowledging
relay cleanup, reloads the database and verifies that neither its old nor current
generation can regain access. The other grant remains enabled. Eventual cleanup
only discards the blocked record. The browser acceptance fixture loses a committed
completion reply at QR expiry and checks that the existing card is preserved,
the owner sees the cleanup explanation and automatic QR renewal stops.

Verified 2026-10-22: all 18 native smoke tests (two navigation/security and 16
storage/enrollment) pass on the owned API-35 emulator. Browser phone-management
acceptance passes the lost-receipt-at-expiry regression, ordinary pairing,
preserved metadata, cross-tab session closure and forgetting, with readable
pairing/recovery pages and no horizontal overflow at 320 pixels. The 130
TypeScript tests, type checks, Biome checks, Kotlin protocol tests, Android
debug/release APK builds and lint pass. Private evidence stays in ignored
`.local/sg5-proof/` and the existing runner artifact directories. No physical
phone, hosted deployment or Play release was changed.

## Local security settings (2026-10-22)

The behavior below remains the **unrestricted-control off** policy. Android
0.10.0 adds an owner-authorized Settings switch allowing trusted remote
controllers to configure these screens, including pairing-code capture. See
[the configuration plan and evidence](cli-control.md#next-slice-unrestricted-remote-configuration).
The code-11 upgrade exception is persistent and one-time; existing pause,
revocation and credential-entry permission remain separate.


Pairing/approval, per-device unlock permission and saved-PIN management use
dedicated native screens that suspend remote input while visible. Ordinary
management pages remain remotely usable. Both the phone and viewer explain:
these changes must be made directly on the phone so a connected device cannot
pair another device or grant itself unlock access. Remote Back and Home remain
available, and local touches continue to work.

The accessibility command boundary enforces this for relay and direct sessions,
including modified clients. A protection revision invalidates queued input even
if the screen has since closed. Entering/leaving protection invalidates input
geometry and releases held contacts; protected controls appear only after any
previously dispatched gesture/release has finished. Activity visibility owns the
gate, including recreation and multiple activity instances, so returning to
another app restores ordinary input. Saved-PIN entry dialogs inherit their protected
page and retain their secure-window flag.

The encrypted state includes the optional boolean `localSettings`; existing beta
viewers can ignore it while native enforcement still applies. New viewers show
the explanation over the phone screen, including when the PIN dialog prevents
capture. No new result codes, storage changes or relay changes are required.

`pnpm test:mobile-ui` includes native command-versus-local-input regression
coverage on its owned emulator: permission escalation attempts, touch/swipe/text,
held-input release, queued input across screen entry/exit, rotation, pairing
approval, PIN save/forget, and Back/Home escape. `pnpm test:viewer-layout` checks
the browser explanation and return to ordinary viewing at all five viewports.

Verified 2026-10-22 on the runner-owned API 35 emulator: both navigation and
security-setting instrumentation tests passed, including real persisted local
unlock permission changes, synthetic PIN save/forget, rejected remote input and
pairing approval, rotation, held-contact release, queued-input rejection and
remote Back/Home escape. No device lock credential was changed. Browser layout
acceptance passed at all five sizes; native and browser captures were inspected.
The 120 TypeScript tests, Kotlin protocol tests, builds, type checking, formatting
and Android lint passed. Private captures/receipts remain under `.local/`. This
does not claim physical-phone or Play-installed acceptance or a deployment.

## Authority and transport

Phone policy is authoritative for foreground and background work and every
handshake/record. Persist policy generations; queued work and delayed pushes
from an earlier generation cannot become valid after re-enabling. Wake hints
identify a pairing and generation but confer no authority: the selected grant,
relay challenge and E2E handshake still authenticate the actual browser.

Synchronize signed phone-only access policy with the relay, canceling affected
pending routes on policy changes. Keep management sockets separate from sessions
so pausing/removing a browser never needs active session admission. Push
registration is per pairing; one installation can serve multiple browser grants.
Preserve v1 enrollment/crypto wire compatibility and existing relay state.

## Delivery and verification

1. Commit this plan.
2. Add Room, transactional legacy migration and bounded history with native tests.
3. Implement policy-aware sessions, multi-browser wake routing and relay tests.
4. Implement compact native screens and instrument normal controls.
5. Run builds, type checking, lint, meaningful policy/migration tests and a real
   two-isolated-browser / owned-emulator acceptance, including actual FCM,
   persistence, global/per-browser pause, stale work, disconnect and revocation.
   Capture the real UI. Deploy the compatible relay revision through the existing
   Pi runbook and commit working slices. Keep private artifacts under `.local/`.

Physical lock/debugging settings, unrelated apps, existing transports and services
are unchanged. Natural overnight/reboot qualification remains separate.

## Implementation and acceptance

Implemented in the root Android host and hosted relay on 2026-10-20. The UI uses
plain native views, AndroidX back handling and a scrollable status/list rather
than the earlier HTML mockups. Up to 32 independently pinned browser grants can
be retained; owners can rename, pause, disconnect and remove each one. Settings
separates automatic requests from global permission. Activity is local, loads history in batches, and is pruned at startup/read/write to 30 days/10,000 rows. Room schemas are
exported and every version has a hand-written migration tested with
`MigrationTestHelper`. Version 3 renames the `browsers` table to `devices`, the
activity columns to `deviceId`/`deviceName`, and rewrites stored "Browser …"
history entries as "Device …". Database/preferences/files are explicitly
excluded from cloud backup and device transfer; signing keys remain in Keystore.

`pnpm test:mobile` requires the normal Android build with the operator's ignored
Firebase client configuration and `HOSTED_ORIGIN` pointing at the compatible
hosted relay. It owns an API-35 Google APIs emulator and two isolated Chromium
contexts. It never selects a physical phone. It tests rendered-QR decoding,
ordinary Grant/rename/switch/confirmation controls, both encrypted checks, real
FCM wake with the app process absent for each browser, persisted aliases and
last-connected timestamps, global/per-browser gating, active route closure,
disconnect without unpairing, isolated removal and subsequent rejection.
The native Room tests cover transactional legacy import, preserved revocation,
independent authority, superseded generations and bounded/redacted history.

Private screenshots, native logs and the result receipt live under
`.local/mobile-proof/`. Fixture writes are atomic. A previous interrupted owned
fixture is revoked with its retained native key before any app-data reset; failed
cleanup preserves the AVD for repair. Both normal acceptance and management
acceptance close their browser/emulator processes.

The final management run passed all the checks above, including real
FCM receipt and encrypted exchanges for both browser identities, persisted global
disarm after process restart, and pausing one browser while the other remained
connected. The existing single-browser hosted/FCM regression also passed against
the final deployed relay: three encrypted exchanges, restart/reload persistence,
process-absent wake, revocation and rejection. Build, Android
lint, ktlint, TypeScript checking, Biome, 63 TS tests and 14 Kotlin protocol tests
pass. Three native Room tests and the command-driven native management flow pass.
This is emulator evidence; it does not extend the earlier physical Pixel receipt
to the new management UI or qualify natural overnight/reboot recovery. Screen
capture/input and WebRTC remain separate product slices.

## Consumer copy and system readiness

The owner's follow-up removes development banners, future-feature promises,
manual connection-check controls, raw session diagnostics and the build suffix
from the mobile UI. Home shows access, connection status and paired browsers;
an actionable Settings link appears when setup needs attention. Settings holds
notification repair, unused-app settings, connection setup and About. About
accurately describes this version's pairing/secure-check scope.

On startup and every Activity resume, query the actual notification permission,
app-wide notification setting and connection channel. A changed result refreshes
the UI and resynchronizes push registration, including after permission restoration.
Saved owner preferences are retained; they are not evidence of OS permission.
Background push handling and every automatic session still check current permission.

Also query AndroidX's unused-app restrictions API asynchronously on resume. Show
whether Android's permission removal/hibernation setting is enabled, disabled,
unavailable or could not be read, with the supported system settings action.
This reports configuration, not proof that hibernation occurred, nor a promise
of overnight reachability. The app does not change the setting or request a
battery exemption automatically.

Official API references, reviewed 2026-10-20:

- [PackageManagerCompat.getUnusedAppRestrictionsStatus](https://developer.android.com/reference/androidx/core/content/PackageManagerCompat#getUnusedAppRestrictionsStatus(android.content.Context))
- [IntentCompat.createManageUnusedAppRestrictionsIntent](https://developer.android.com/reference/androidx/core/content/IntentCompat#createManageUnusedAppRestrictionsIntent(android.content.Context,java.lang.String))
- [App hibernation behavior](https://developer.android.com/topic/performance/app-hibernation)

The mobile acceptance now checks an external notification-settings round trip,
notification blocking/restoration while resuming the existing Settings screen,
and runtime permission revocation/restoration across process startup. The same
run then verifies real process-absent FCM delivery to both paired browsers.
All permission mutations are restricted to the runner's owned emulator.

This follow-up acceptance passed on 2026-10-20, including the unused-app and
notification system-settings round trips, channel blocking and repair through
Android Settings, runtime permission revoke/regrant, both real FCM wakes, all
existing multi-browser policy checks and signed fixture removal. Android builds,
lint/ktlint, TS checking and Biome passed. Actual native screenshots were inspected;
private receipts and captures remain in `.local/mobile-proof/`. No physical phone
or deployed relay change was required.

## Sharing setup and independent feature permissions

Owner direction, 2026-10-20:

- Superseded 2026-10-21 by the owner: Home leads with a large Scan pairing code
  tile that opens the scanner in one tap, then a website row (address, copy,
  Android share, and a website QR that expands in place), then up to three paired
  devices with All devices. The setup dialog and the drawer's How to connect entry
  are gone; Devices › Add device also opens the scanner. A website QR is a public
  navigation link, never a pairing grant. Typing the address on a laptop remains
  supported.
- Scanning/deep-link approval and durable browser trust have no accessibility,
  notification or capture prerequisite. After pairing, show a separate feature
  setup screen with a Done action. Each available feature explains its purpose
  before the owner chooses its permission. Permission denial keeps the pairing.
- Connection requests can be enabled in this host. Screen viewing and touch
  control are not implemented in the root host: report their unavailability
  honestly, without unrelated system permission prompts or fake Enable actions.
- While the phone app is visible, allowed browsers can connect without Android
  permissions or FCM opt-in. Foreground listeners do not reserve session leases;
  actual connections still enforce one session, current grant generations and
  all global/per-browser policies. Leaving the app closes those listeners.
- Send a small optional E2E-encrypted feature report after the existing canary
  reply. Preserve the existing handshake/canary contract for older viewers and
  tolerate absence of a report from older hosts. The viewer explains per-feature
  availability after connecting; it never infers capabilities from relay data.
- Extend the owned-emulator/two-browser acceptance: empty-state setup and website
  QR, pairing and real foreground exchange before permissions, feature setup
  skipping/denial, authenticated feature reporting, then existing FCM/policy
  regression and cleanup. Capture actual native screens and deploy the updated
  viewer through the existing Pi runbook after verification.

Website QR encoding dependency review, 2026-10-20: only Maven component
`com.google.zxing:core:3.5.3` is used, for generating a public HTTPS navigation QR.
The pinned upstream [license](https://github.com/zxing/zxing/blob/zxing-3.5.3/LICENSE)
is Apache-2.0, source-reviewed; copies of the license and pinned upstream NOTICE
ship in APK assets. No competitor APK,
native library or Android camera implementation is reused. The existing Google
Play services scanner continues to handle scanning without an app camera permission.

Sharing acceptance passed on 2026-10-20 with the owned API-35 emulator and two
isolated Chromium contexts against the public relay. It decoded the displayed
website QR, checked Copy and the Android share sheet, approved both browser grants
before permissions, skipped feature setup, and completed real foreground encrypted
checks with authenticated feature states. An explicit notification Deny retained
both pairings and foreground access; a later Allow enabled both process-absent FCM
wakes. Notification-channel repair, runtime revoke/regrant, pause, stale generations,
disconnect, restart persistence and isolated removal also passed. All owned grants
and test processes were cleaned up. These checks do not include camera optics,
physical-phone installation, screen capture/input or natural overnight availability.

The final Android build/lint/ktlint, TS build/type checks/Biome, 71 TS tests,
14 Kotlin protocol tests and three native Room tests passed. Real captures are in
the ignored `.local/mobile-proof/` directory, including `home-first-run.png`,
`sharing-setup.png`, `sharing-website-qr.png` and `feature-setup.png`.
The existing single-browser hosted/FCM regression also passed after deployment:
three encrypted checks, process-absent Firebase delivery, restart/reload
persistence, revocation and subsequent refusal. The production viewer/relay
release is `29b8295`; later documentation/license-asset changes do not alter its
wire behavior. Final APK assets include the pinned upstream license and NOTICE.

## Simplified navigation and appearance

Owner direction, 2026-10-20: keep initial use focused on basic phone settings
and local activity. Per-browser grants remain useful, but are secondary UI.
Add familiar native navigation, Light/Dark appearance and a minimal green accent.

The Android host now has a fixed title bar and native hamburger drawer with
Home, Activity and Settings. Detail screens use a back arrow; Android Back closes
the drawer first or returns through the actual navigation hierarchy. The selected
page and its parent stack survive Activity recreation. The drawer stays intact
while connection/readiness updates refresh page content.

- Home shows the global access switch, current connection/readiness, Stop
  connection while connected, the Scan pairing code tile, the website row and
  recent devices. Specific repair
  rows lead to the Settings checklist or Connection details. Choosing to connect
  only while the app is open is a valid configuration, not unfinished setup.
- Settings opens with a setup checklist: recommended switches for Screen and
  control, Connect while the app is closed and Reconnect after restart, with an
  "n of 3 on" count, then optional Save PIN on this phone. Each switch shows
  Android's actual state; a tap starts the change (disclosure, permission prompt
  or system page) and the switch follows once Android reports it. Connection
  details holds notification status, unused-app status and Retry setup.
  Appearance and About follow.
- Unused-app handling ("Manage app if unused" on Android 17) is not a checklist
  item. Observed on a Pixel 9, Android 17, 2026-10-21: PermissionController logs
  `Exempted dev.remoteaccess.host - Has exempt components:
  android.accessibilityservice.AccessibilityService` and greys out the toggle
  while screen access is enabled. AndroidX's restriction status does not report
  that exemption, so Connection details checks the enabled accessibility service
  itself and only points to App info when the restriction applies.
- Devices is a top-level drawer page. Paired clients are called devices because
  later clients need not be browsers; each entry's name says what it is
  ("Chrome on macOS"). Nicknames, per-device access/unlock switches, disconnect
  and confirmed removal live there. Existing grant defaults and authority checks
  are unchanged.
- Pairing still works before Android permissions. The skippable post-pairing
  Finish setup page shows the same checklist plus the new device's unlock
  permission. There is one control for each preference.
- Activity remains bounded, local history with event/browser/time entries. The
  redesign does not extend retention, capture screen content or make history a
  tamper-proof audit service. It does not add one-time grants or a new browser
  identity protocol; local names and paired/last-used times retain their limits.
- Appearance offers System (default), Light and Dark. The explicit choice persists
  locally and takes precedence over the phone's theme; System follows Android
  changes. Both palettes use green accents, neutral surfaces, readable secondary
  text and green primary actions. Native permission explanations and dialogs use
  the selected Activity theme. Appearance is separate from access policy.

The UI stays in Kotlin/native views, with AndroidX DrawerLayout 1.2.0 for modal
drawer behavior. The exact artifact's published POM declares Apache-2.0 (reviewed
2026-10-20); see its [release](https://developer.android.com/jetpack/androidx/releases/drawerlayout#1.2.0)
and [POM](https://dl.google.com/dl/android/maven2/androidx/drawerlayout/drawerlayout/1.2.0/drawerlayout-1.2.0.pom).
There is no viewer/relay/protocol or database-schema change.

### Verification

`pnpm build:android` builds the app and instrumentation APK. Then run:

```sh
pnpm test:mobile-ui
HOSTED_ORIGIN=https://YOUR_DEVELOPMENT_ORIGIN pnpm test:mobile
```

The new relay-independent runner owns an API-35 emulator on port 5596, refuses
an occupied selector, and closes its emulator. It exercises the actual native
UI: the simple first-run Home, drawer selection/dismissal, Settings/detail Back,
fixed title bar while scrolling, explicit Light/Dark, persistence across task
restart, Android theme changes, themed sharing dialog and landscape recreation.
System appearance and rotation overrides are restored in the test's finally
block. Screenshots, instrumentation output and receipt stay in ignored
`.local/mobile-ui-proof/`.

The existing hosted management runner uses the new drawer and Settings paths to
exercise real two-browser pairing, renaming, foreground access, notification
repair, process-absent FCM, global/per-browser policy, disconnect and revocation.
It keeps its separate owned emulator and isolated browser fixtures. No physical
phone or lock/debugging setting is selected by either run.

Both acceptance runs passed on 2026-10-20. Native screenshots were visually
reviewed in Light/Dark, the sharing dialog and landscape, including an explicit
Light choice while Android uses Dark. The hosted run passed all three Room tests,
both real foreground exchanges and process-absent FCM wakes, persisted aliases,
notification repair/revocation/restoration, global and per-browser policy,
disconnect and isolated removal of both fixture grants. Android debug/test builds,
Android lint, ktlint, TypeScript checking, the new runner's Biome check and
`git diff --check` also passed. These are owned-emulator results, not a new
physical-phone, reboot or natural overnight qualification.

## Pairing completion and returning Home

Owner direction, 2026-10-21: once a device is paired, Home should emphasize
existing access rather than continue to look like first-run setup. This
supersedes the always-visible scanner/website layout and the post-pairing
navigation described above.

- With no paired devices, Home retains the large one-tap scanner and a link to
  the website tools. Once paired, Home shows access status, paired devices and
  a compact Add device row. Add device from Home or Devices opens a pairing
  page containing the scanner and website address/copy/share/QR tools.
- The first device opens Set up this phone after approval, with a persistent
  pairing confirmation and a fixed Continue button available without scrolling
  or enabling any permissions.
  Continue opens that device's details. Further devices go directly to their
  details, with a brief accessible pairing confirmation. Back returns Home;
  completed pairing/setup screens are not left on the navigation stack.
- Setup explains capabilities rather than scoring a required checklist. Screen
  and control enables viewing/input; background requests and restart recovery
  are independent choices. Restart recovery still requires the first local
  unlock. Unlock permission and saving a PIN remain optional. Settings retains
  the same controls and setup explicitly says choices can be changed later.
- Device details lead with connection status and access controls. A Phone setup
  action appears when screen access is off or opted-in background requests need
  notification permission. Missing optional settings alone do not trigger it.
  Pairing/connection timestamps and removal follow the controls.
- Activity recreation retains the post-pairing destination instead of reopening
  the consumed App Link. Permission and access-policy behavior is unchanged;
  this is a native navigation/presentation change with no protocol or storage
  format change.

The native navigation runner covers the Add device page from Home and Devices.
The two-browser hosted runner verifies first-pair setup skipping, direct arrival
at later-device details, repair navigation, rotation and Back, and Home's paired
layout alongside the existing encrypted foreground, permission-denial, FCM and
access-management checks. Captures and receipts remain in ignored
`.local/mobile-ui-proof/` and `.local/mobile-proof/`.

Both runners passed on 2026-10-21, including all three native Room tests, the
new pairing/navigation assertions, both process-absent FCM wakes and the existing
policy/disconnect/removal checks. Actual setup, detail and paired-Home captures
were visually reviewed. Android debug/test builds, Android lint/ktlint,
TypeScript checking, the changed runner's Biome check and `git diff --check`
passed. These runs used owned emulators and isolated Chromium; both test devices
were revoked and the runner processes closed.

## Distinct phone and browser roles — 2026-10-25

The onboarding candidate labels the native app **This phone**, **Allowed browsers**
and **Allow a browser**; its purpose is allowing control of this phone. The web
controller separately lists **Your phones** and offers **Control a phone**. Both
website entry roles and the public Play installation action remain visible.
Native share/copy/QR shortcuts point directly to browser pairing at `/pair`.
Scanner pending state survives recreation, suppresses duplicate starts and ignores
late results after leaving. See [the pairing flow and checks](onboarding.md).
