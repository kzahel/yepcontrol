# YepControl

View and control your Android phone from a browser. Pair by scanning a QR code,
approve access on the phone, and connect through an end-to-end encrypted session.

[Get it on Google Play](https://play.google.com/store/apps/details?id=com.yepcontrol.app) · [Open YepControl](https://yepcontrol.com) · [Privacy policy](https://yepcontrol.com/privacy/)

- Screen viewing, smooth video, touch gestures, text entry and navigation.
- Multiple phones and browsers, with per-browser permissions and revocation.
- Optional background wake and saved-PIN unlock.
- Android 11+; application ID `com.yepcontrol.app`.

**Play release:** version 0.7.0 is publicly available on Google Play, verified
2026-10-25 from the signed-out listing with Install and no tester enrollment. See the
[production release record](docs/distribution/android-production.md).

Screen control requires Android's screen-access permission; smooth video asks
for screen-sharing consent. After a reboot, the phone needs its first local
unlock. Protected screens and background availability remain subject to Android
restrictions. No account or AI service is required.

## Development

Requires Node 24 LTS (pinned in `.node-version`), pnpm 10.30.3, JDK 17 and
Android SDK platform 37 with build tools 36.0.0. Set `ANDROID_HOME`;
the Gradle wrapper is included.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:android
```

With Tailscale running on the computer and phone, `pnpm dev` starts the relay,
Vite viewer and a temporary HTTPS endpoint through `tailscale serve`. Open the
printed URL and scan its pairing code. Ctrl+C removes the temporary endpoint.
Use `DEV_HTTPS_PORT` if port 443 is already served.

The relay stores local development state in `.local/dev-relay/`. Background wake
requires `FIREBASE_PROJECT_ID` and matching private Firebase credentials in the
relay environment. The checked-in Android Firebase configuration is public
client configuration; a separate deployment needs its own Firebase registration.
Never commit service-account credentials.

To show a development URL in the Android app, set
`devSharingWebsite=https://YOUR_ORIGIN` in ignored `android/local.properties`.
For a separate deployment, build with `-PsharingWebsite=https://YOUR_ORIGIN`.
See [App Links and installation](docs/app-links.md).

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm exec playwright install chromium
```

| Command | Coverage |
| --- | --- |
| `pnpm test:public-site` | Public homepage, installation, QR links and returning browsers. |
| `pnpm test:viewer-layout` | Responsive viewer layout in isolated Chromium. |
| `pnpm test:viewer-phones` | Browser phone storage, multiple phones and tabs. |
| `pnpm test:interop` | Browser ↔ Android Keystore interoperability. |
| `pnpm test:smooth-view` | Smooth toggle, consent, video and teardown on an owned emulator. |
| `pnpm test:mobile-ui` | Native navigation, setup and appearance. |
| `pnpm test:hosted` | Hosted QR pairing, reconnect, FCM wake and revocation. |
| `pnpm test:mobile` | Multiple browsers and native access management. |

PRs and pushes run the browser layout and phone-management checks alongside
builds, unit tests, lint and secret scanning. CodeQL scans production components.
Owned-emulator crypto, native navigation and storage smoke tests run nightly,
on manual dispatch and before building a signed Android release.

Android acceptance runners own their emulators. Install the API 35 Google APIs
system image for your host architecture; Linux also needs KVM. Hosted runners
require `HOSTED_ORIGIN=https://YOUR_DEVELOPMENT_ORIGIN`. Private logs and captures
stay in ignored `.local/` directories.

Emulator and Pixel 7a tests cover encrypted pairing, process-absent FCM wake,
viewing, input, video, direct transport and relay recovery. Emulator tests also
cover PIN unlock and reboot recovery. A Play-installed 0.7.0 Pixel 7a smoke check
verifies viewing, navigation, background reconnect and consented smooth video;
it also reproduces a [roughly 30-second connection delay](docs/connection-delay.md).
Natural overnight availability and broader device qualification remain pending. See
[control acceptance](docs/control-acceptance.md) and the
[beta verification record](docs/distribution/android-beta.md).

## Documentation

- [Beta builds, signing and Play publishing](docs/distribution/android-beta.md)
- [First public Play submission](docs/distribution/android-production.md)
- [Security decisions and open gaps](docs/security-gaps.md)
- [Pairing and relay](docs/pairing-relay-v1.md) · [Session encryption](docs/crypto-session-v1.md)
- [Smooth-view consent and lifecycle](docs/smooth-view-lifecycle.md)
- [Android permissions and device management](docs/mobile-management.md)
- [Browser phone management](docs/browser-phones.md)
- [Android platform limits](docs/android-platform.md)
- [Original prototype](spike/README.md)

The encryption design has not had an independent security review.

## License

[MIT](LICENSE). Third-party components retain their own licenses and notices;
see the [dependency review](docs/direct-transport.md). The
[public-source audit](docs/publication-audit.md) records the pre-publication
history and infrastructure review.
