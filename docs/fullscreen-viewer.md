# Responsive and fullscreen web viewer

The live viewer's **Fullscreen** button expands the remote screen on mobile and
desktop. Back, Home and Recents stay visible in a bottom navigation bar beside
**More controls** and **Exit fullscreen**. More controls contains screen wake,
lock, quality, typing/app launching and disconnect. The image preserves its
aspect ratio and fits above the bar. Healthy connection status and the idle
media toolbar collapse in fullscreen; **More controls** reveals media controls.
Repair messages, active camera/microphone controls and microphone failure messages
stay visible. Client control-label preferences continue to apply.

Portrait browser viewports below 900 CSS pixels use the same bottom navigation
bar without requiring fullscreen. Secondary controls open above the bar and
close when selecting Lock phone or typing controls, tapping outside, or pressing Escape.
Wide layouts retain the side dock beside the picture.

The live picture uses the actual displayed still/video frame dimensions and
updates when the remote device rotates. Workspace sizing uses its measured
available height, replacing the fixed phone ratio and estimated viewport offsets.
The canvas itself occupies the largest contained image rectangle, preserving
remote touch coordinates without including the surrounding empty space. Local
rotation and image resizing release held input without reconnecting. Tablet and
phone proportions can still leave empty space; the complete screen remains
visible without stretching, cropping or zoom.

The browser Fullscreen API is requested directly from the user's button press.
If unavailable or rejected, the viewer uses the same layout within the visible
browser viewport; browser chrome may remain. Safe-area padding accommodates
display cutouts and the local home indicator where the browser exposes them.

The client device's system Back gesture remains controlled by its OS/browser.
When the browser exits fullscreen, the viewer returns to its ordinary layout
without reconnecting or issuing remote Back. Use the bottom **Back** button to
navigate on the remote phone. Escape also exits the viewport fallback. These
transitions release held remote input; they do not promise rollback of an action
already delivered. Disconnect or removal of the live viewer exits native
fullscreen. No history entries or automatic fullscreen re-entry are used.

## Verification

`pnpm test:viewer-layout` uses an isolated Playwright Chromium and synthetic
session, with no physical device or relay. It exercises native fullscreen,
unsupported-API and rejected-request fallback at desktop, wide desktop, mobile,
small mobile and landscape viewport sizes. It checks bottom navigation, contained
image aspect, remote navigation without fullscreen exit, quality-dialog access,
the same canvas across transitions, held-input release on external fullscreen
exit, dialog-first fallback Escape, fallback button exits, labeled bottom-bar
touch targets, native fullscreen cleanup on unmount and restored ordinary
geometry. Additional landscape/portrait tablet cases check maximum contained
picture size, full portrait-phone width, changing viewport heights, remote and
local rotation, mapped touch coordinates, canvas preservation and warning recovery.
`pnpm test:viewer-media` checks visible controls while sharing in fullscreen;
`pnpm test:viewer-phones` checks saved phones and preview/live transitions.
Screenshots and results stay under ignored `.local/viewer-layout-proof/`.

This is automated Chromium evidence. It does not qualify physical OS edge
gestures, iPhone/Safari behavior or every mobile browser. The browser's exit
authority and user-activation requirement follow the
[Fullscreen standard](https://fullscreen.spec.whatwg.org/#ui) (reviewed
2026-10-21); the exact local gesture remains browser/platform behavior.
