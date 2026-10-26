import { expect, it } from "vitest";
import {
  decodeInvitation,
  encodeInvitation,
  type Grant,
  grantBytes,
  grantMac,
  hex,
  type Invitation,
  verifyOffer,
} from "../src/enrollment.js";
import { b64, createIdentity } from "../src/index.js";

async function invitation(): Promise<Invitation> {
  return {
    v: 1,
    origin: "https://yepcontrol.com",
    id: "11".repeat(16),
    secret: "22".repeat(32),
    viewer: b64((await createIdentity()).publicKey),
    expires: Math.floor(Date.now() / 1000) + 300,
    name: "Chrome on macOS",
  };
}
it("encodes an HTTPS App Link with all pairing material confined to the fragment", async () => {
  const i = await invitation();
  const link = encodeInvitation(i);
  const url = new URL(link);
  expect(url.origin + url.pathname + url.search).toBe(
    "https://yepcontrol.com/enroll",
  );
  expect(decodeInvitation(link)).toEqual(i);
  expect(
    decodeInvitation(
      encodeInvitation({ ...i, origin: "https://dev.example:8443" }),
    ).origin,
  ).toBe("https://dev.example:8443");
});
it("rejects transplanted invitations, malformed links and expired codes", async () => {
  const i = await invitation();
  const link = encodeInvitation(i);
  for (const changed of [
    link.replace("yepcontrol.com", "other.example"),
    link.replace("https:", "http:"),
    link.replace("/enroll#", "/enroll?secret=leak#"),
    link.replace("/enroll#", "/other#"),
    link.replace("https://", "https://user@"),
    link.split("#")[0] ?? "",
    `ara-pair://enroll#${new URL(link).hash.slice(1)}`,
    encodeInvitation({ ...i, expires: Math.floor(Date.now() / 1000) - 1 }),
  ]) {
    expect(() => decodeInvitation(changed)).toThrow();
  }
});
it("checks signed offers against the calibrated clock without extending expiry", async () => {
  const i = await invitation();
  const phone = await createIdentity();
  const g: Grant = {
    id: i.id,
    viewer: i.viewer,
    phone: b64(phone.publicKey),
    expires: i.expires,
    phoneSignature: "",
    mac: "",
  };
  const bytes = grantBytes(i.origin, g);
  g.phoneSignature = b64(await phone.sign(bytes));
  g.mac = hex(await grantMac(i.secret, bytes));
  await verifyOffer(i, g, i.expires * 1000 - 1);
  await expect(verifyOffer(i, g, i.expires * 1000)).rejects.toThrow("expired");
  await expect(
    verifyOffer(i, { ...g, expires: i.expires + 1 }, i.expires * 1000 - 1),
  ).rejects.toThrow("Wrong");
});
