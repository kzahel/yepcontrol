import { b64, createIdentity } from "@remote/protocol";
import { encodeInvitation, type Invitation } from "@remote/protocol/enrollment";
import { beforeAll, describe, expect, it } from "vitest";
import { pairingAppLink, playListing } from "../src/enrollment-link.js";

const origin = "https://pairing.example";
let invitation: Invitation;
beforeAll(async () => {
  const identity = await createIdentity();
  invitation = {
    v: 1,
    origin,
    id: "a".repeat(32),
    viewer: b64(identity.publicKey),
    secret: "b".repeat(64),
    expires: Math.floor(Date.now() / 1000) + 300,
    name: "Controlling browser",
  };
});
describe("explicit Android pairing handoff", () => {
  it("retains the app link and pins the package and public-only fallback", () => {
    const link = encodeInvitation(invitation);
    const result = pairingAppLink(link, origin);
    expect(result.href).toBe(
      `${link.replace(/^https:/, "intent:")}#Intent;scheme=https;package=com.yepcontrol.app;S.browser_fallback_url=${encodeURIComponent(playListing)};end`,
    );
    expect(result.invitation).toEqual(invitation);
    expect(playListing).not.toContain(invitation.secret);
  });
  it("rejects a valid invitation from another website", () => {
    expect(() =>
      pairingAppLink(encodeInvitation(invitation), "https://other.example"),
    ).toThrow("Wrong pairing service");
  });
  it("rejects expired invitations", () => {
    expect(() =>
      pairingAppLink(encodeInvitation({ ...invitation, expires: 1 }), origin),
    ).toThrow("Expired pairing code");
  });
  it("rejects query injection and malformed pairing fragments", () => {
    const link = encodeInvitation(invitation).replace(
      "/enroll#",
      "/enroll?secret=leak#",
    );
    expect(() => pairingAppLink(link, origin)).toThrow();
    expect(() => pairingAppLink(`${origin}/enroll#invalid`, origin)).toThrow();
  });
});
