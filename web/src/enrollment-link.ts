import { decodeInvitation } from "@remote/protocol/enrollment";

export const playListing =
  "https://play.google.com/store/apps/details?id=com.yepcontrol.app";

/** Explicit user-click handoff; the fallback must never carry pairing authority. */
export function pairingAppLink(uri: string, expectedOrigin: string) {
  const invitation = decodeInvitation(uri);
  if (invitation.origin !== expectedOrigin)
    throw Error("Wrong pairing service");
  const href = `${uri.replace(/^https:/, "intent:")}#Intent;scheme=https;package=com.yepcontrol.app;S.browser_fallback_url=${encodeURIComponent(playListing)};end`;
  return { invitation, href };
}
