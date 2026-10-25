import { pairingAppLink } from "./enrollment-link.js";

// Keep valid invitations only in page memory for an explicit app handoff.
// Never persist them or send them to Play. Installation does not resume pairing.
let expiry: ReturnType<typeof setTimeout> | undefined;
function receiveLink() {
  const incoming = location.href;
  history.replaceState(null, "", location.pathname);
  clearTimeout(expiry);
  const target = document.getElementById("pairing-app-action");
  if (!target) return;
  target.replaceChildren();
  if (!new URL(incoming).hash) return;
  try {
    const { invitation, href } = pairingAppLink(incoming, location.origin);
    const link = document.createElement("a");
    link.className = "button-link";
    link.href = href;
    link.textContent = "Open pairing in YepControl";
    target.append(link);
    expiry = setTimeout(
      () => {
        target.textContent =
          "This pairing link expired. Get a fresh link or code from the controlling browser.";
      },
      Math.max(0, invitation.expires * 1000 - Date.now()),
    );
  } catch {
    target.textContent =
      "This pairing link is invalid or expired. Get a fresh link or code from the controlling browser.";
  }
}
receiveLink();
// A second pairing link can navigate within this document rather than reload it.
addEventListener("hashchange", receiveLink);
