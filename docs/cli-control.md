# CLI pairing and accessibility control

Owner-authorized 2026-10-30: implement a shared web/CLI client, terminal pairing,
and basic accessibility observation and control, with owned-emulator acceptance.
After each implementation phase, request an independent Sol 6.1 High review via
the Yep Anywhere API with bypass permissions, address findings, and commit.

## Implementation phases

1. Establish the unchanged build, unit, browser and emulator regression baseline.
2. Extract pairing, encrypted relay sessions and ordered commands into a shared
   TypeScript client package. Keep browser persistence, rendering and direct
   transport adapters in the web app. Preserve public hosts and existing grants.
3. Add a CLI with its own named identity, both pairing directions, saved phones,
   status, screenshots, gestures, text, navigation, app launch and a persistent
   JSON-lines session. Keep secrets out of arguments and routine logs.
4. Add bounded accessibility snapshots and observation-bound node click, scroll
   and text. Redact password fields, expire references and revalidate targets.
   Advertise support additively so existing hosts remain usable.
5. Qualify the real CLI and existing browser against an owned emulator; retain
   meaningful regression coverage in CI and document exact evidence and limits.

ADB extensions, reboot redesign, MCP, video in the CLI and an autonomous planner
are outside this implementation. The existing screen-access permission and
phone-local access controls remain authoritative.

## Acceptance

- Both pairing directions, invitation expiry/cancellation, persisted identity,
  reconnect and independent client revocation.
- Screenshot and bounded UI snapshot; native effects for node click, targeted
  text, scroll, coordinate gestures, navigation and application launch.
- Refusal for stale observations, changed nodes, invalid coordinates, locked
  screens, protected local settings and missing accessibility permission.
- No replay after an uncertain delivery; bounded queues, cancellation and teardown.
- CLI pause/removal ends access while another paired browser remains usable.
- Existing browser pairing/storage, prepared connections, continuous touch,
  smooth video and direct/relay recovery remain covered.
- Existing public host capabilities and pairings retain their wire formats.

The CLI acceptance sends control through YepControl's encrypted transport without
a browser. ADB may provision the owned emulator and independently inspect fixture
effects; it must not deliver the CLI's target actions. Private logs, screenshots,
keys and grants stay in ignored `.local/` paths. Emulator qualification does not
establish physical-device, first-unlock, overnight or Play-policy acceptance.

## Evidence

### Baseline and shared client — 2026-10-30

The unchanged baseline passes 157 TypeScript tests, Kotlin protocol tests,
Android build/lint, public-site pairing and browser phone-management acceptance.
The first layout run timed out waiting for its permission overlay; the complete
five-size run passed after extraction. Installed JDK 17 must be selected explicitly
on this machine. The emulator requires DNS that resolves the development origin.

The original APK and built viewer pass owned API-35 emulator control: native
tap/text, held slider, long press, two-pointer gestures, watchdog release,
navigation, disarm/removal, smooth H.264 over direct WebRTC and direct-path loss
recovering to the relay without replay. This is the pre-extraction device baseline.

`client/` now owns pairing primitives, HTTP requests, encrypted relay sessions and
ordered command handling. Browser persistence and WebRTC remain adapters.
Development resolves shared source directly; production builds emit the package.
Vitest resolves shared source so local tests cannot silently use stale output.
The extraction passes 164 TypeScript tests, typecheck, build, TypeScript lint,
formatting and public-site, five-size layout and phone-management acceptance.

The requested Yep Anywhere Sol 6.1 High reviewer checked the extraction with
bypass permissions. Findings led to cancellation checks before/after lane
acquisition, abort-listener/timer cleanup, skipping absent WebRTC, development
source resolution and direct shared-source regression tests. No wire-format or
pairing-authority bypass was identified. Private reports and receipts remain in
`.local/cli-proof/`.
