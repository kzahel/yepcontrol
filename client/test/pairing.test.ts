import { b64, createIdentity } from "@remote/protocol";
import { sealDevice } from "@remote/protocol/device";
import {
  createBytes,
  type Grant,
  grantBytes,
  grantMac,
  hex,
  verifySignature,
} from "@remote/protocol/enrollment";
import { verifyClaim } from "@remote/protocol/phone-invitation";
import { afterEach, expect, it, vi } from "vitest";
import { acceptOffer, createPairing, phoneClaim } from "../src/pairing.js";

afterEach(() => vi.unstubAllGlobals());
it("creates a signed CLI/browser invitation and authenticates the phone before completion", async () => {
  const viewer = await createIdentity(),
    phone = await createIdentity();
  const fetch = vi.fn(async () => Response.json({ state: "waiting" }));
  vi.stubGlobal("fetch", fetch);
  const origin = "https://example.test";
  const invitation = await createPairing(
    origin,
    viewer,
    "CLI",
    Math.floor(Date.now() / 1000) + 300,
  );
  const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(call[0]).toBe(`${origin}/api/pair/${invitation.id}`);
  const body = JSON.parse(String(call[1].body));
  expect(body.secret).toBeUndefined();
  expect(Object.keys(body).sort()).toEqual(["expires", "signature", "viewer"]);
  await verifySignature(
    invitation.viewer,
    createBytes(origin, invitation),
    body.signature,
  );
  const grant: Grant = {
    id: invitation.id,
    viewer: invitation.viewer,
    phone: b64(phone.publicKey),
    expires: invitation.expires,
    phoneSignature: "",
    mac: "",
  };
  grant.phoneSignature = b64(await phone.sign(grantBytes(origin, grant)));
  grant.mac = hex(await grantMac(invitation.secret, grantBytes(origin, grant)));
  const device = {
    manufacturer: "Google",
    model: "Fixture",
    name: "Test",
    android: "15",
    sdk: 35,
    app: "0.9.0",
  };
  const sealed = await sealDevice(invitation.secret, invitation.id, device);
  const accepted = await acceptOffer(
    viewer,
    invitation,
    grant,
    sealed,
    Date.now(),
  );
  expect(accepted.device).toEqual(device);
  await verifySignature(
    invitation.viewer,
    grantBytes(origin, grant),
    accepted.grant.viewerSignature ?? "",
  );
  await expect(
    acceptOffer(
      viewer,
      invitation,
      { ...grant, phone: invitation.viewer },
      sealed,
      Date.now(),
    ),
  ).rejects.toThrow();
  await expect(
    acceptOffer(viewer, invitation, grant, sealed, invitation.expires * 1000),
  ).rejects.toThrow();
});
it("binds a phone-issued claim to the CLI identity and name", async () => {
  const viewer = await createIdentity(),
    phone = await createIdentity();
  const invite = {
    v: 1 as const,
    origin: "https://example.test",
    id: "12".repeat(16),
    secret: "34".repeat(32),
    phone: b64(phone.publicKey),
    expires: Math.floor(Date.now() / 1000) + 300,
  };
  const claim = await phoneClaim(viewer, invite, "Laptop CLI");
  await verifyClaim(invite, claim);
  await expect(
    verifyClaim(invite, { ...claim, name: "Other client" }),
  ).rejects.toThrow();
});
