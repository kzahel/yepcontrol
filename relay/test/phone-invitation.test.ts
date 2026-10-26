import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { b64, createIdentity, type Identity } from "@remote/protocol";
import {
  type Grant,
  grantBytes,
  grantMac,
  hex,
  revokeBytes,
  verifyOffer,
} from "@remote/protocol/enrollment";
import {
  type BrowserClaim,
  claimBytes,
  type PhoneInvitation,
  phoneCreateBytes,
  verifyClaim,
} from "@remote/protocol/phone-invitation";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createRelay } from "../src/server.js";

const origin = "https://example.test";
let relay: ReturnType<typeof createRelay>, directory: string, base: string;
let phone: Identity, viewer: Identity, invite: PhoneInvitation;
const api = (action = "", value?: unknown) =>
  fetch(
    `${base}/api/pair/${invite.id}${action ? `/${action}` : ""}`,
    value === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        },
  );
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "phone-invite-"));
  relay = createRelay({ origin, stateDir: directory });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const address = relay.server.address();
  if (!address || typeof address === "string") throw Error("No address");
  base = `http://127.0.0.1:${address.port}`;
  phone = await createIdentity();
  viewer = await createIdentity();
  const deadline = (await (await fetch(`${base}/api/pairing-time`)).json()) as {
    expires: number;
  };
  invite = {
    v: 1,
    origin,
    id: hex(crypto.getRandomValues(new Uint8Array(16))),
    secret: hex(crypto.getRandomValues(new Uint8Array(32))),
    phone: b64(phone.publicKey),
    expires: deadline.expires,
  };
});
afterEach(async () => {
  await relay.close();
  await rm(directory, { recursive: true, force: true });
});
async function begin() {
  return api("invite", {
    phone: invite.phone,
    expires: invite.expires,
    signature: b64(await phone.sign(phoneCreateBytes(origin, invite))),
  });
}
async function claim(
  identity = viewer,
  secret = invite.secret,
): Promise<BrowserClaim> {
  const value = { viewer: b64(identity.publicKey), name: "Chrome on Android" };
  const bytes = claimBytes(origin, invite, value);
  return {
    ...value,
    signature: b64(await identity.sign(bytes)),
    mac: hex(await grantMac(secret, bytes)),
  };
}
async function offer(): Promise<Grant> {
  const grant = {
    id: invite.id,
    viewer: b64(viewer.publicKey),
    phone: invite.phone,
    expires: invite.expires,
    phoneSignature: "",
    mac: "",
  };
  const bytes = grantBytes(origin, grant);
  grant.phoneSignature = b64(await phone.sign(bytes));
  grant.mac = hex(await grantMac(invite.secret, bytes));
  return grant;
}
async function revoke() {
  return api("revoke", {
    signature: b64(await phone.sign(revokeBytes(origin, invite.id))),
  });
}

it("creates one unchanged v1 grant from a phone invitation and refuses a second browser", async () => {
  expect((await begin()).status).toBe(201);
  const c = await claim();
  expect((await api("claim", c)).status).toBe(202);
  const received = (await (await api()).json()) as { claim: BrowserClaim };
  await verifyClaim(invite, received.claim);
  expect((await api("claim", await claim(await createIdentity()))).status).toBe(
    400,
  );
  const grant = await offer();
  expect((await api("offer", { ...grant, device: "c2VhbGVk" })).status).toBe(
    202,
  );
  await verifyOffer({ ...invite, viewer: c.viewer, name: c.name }, grant);
  const viewerSignature = b64(await viewer.sign(grantBytes(origin, grant)));
  expect((await api("complete", { viewerSignature })).status).toBe(200);
  expect((await api("claim", c)).status).toBe(400);
  expect((await revoke()).status).toBe(200);
  expect((await api()).status).toBe(410);
});
it("cannot turn a wrong QR secret, name, phone or signature into approval", async () => {
  expect((await begin()).status).toBe(201);
  const c = await claim();
  await expect(
    verifyClaim(invite, { ...c, name: "Another browser" }),
  ).rejects.toThrow();
  await expect(
    verifyClaim(
      { ...invite, phone: b64((await createIdentity()).publicKey) },
      c,
    ),
  ).rejects.toThrow();
  expect((await api("claim", { ...c, signature: "bad" })).status).toBe(400);
  const wrong = await claim(viewer, "00".repeat(32));
  expect((await api("claim", wrong)).status).toBe(202);
  await expect(verifyClaim(invite, wrong)).rejects.toThrow("Untrusted browser");
  expect((await revoke()).status).toBe(200);
  expect(
    (await api("offer", { ...(await offer()), device: "c2VhbGVk" })).status,
  ).toBe(400);
  expect((await api()).status).toBe(410);
});
it("lets exactly one competing signed claim bind the invitation", async () => {
  await begin();
  const claims = await Promise.all([claim(), claim(await createIdentity())]);
  const responses = await Promise.all(claims.map((c) => api("claim", c)));
  expect(responses.map((r) => r.status).sort()).toEqual([202, 400]);
  const result = (await (await api()).json()) as { claim: BrowserClaim };
  await verifyClaim(invite, result.claim);
  await revoke();
});
it("cancels an unclaimed code without allowing recreation or later claims", async () => {
  await begin();
  await revoke();
  expect((await begin()).status).toBe(400);
  expect((await api("claim", await claim())).status).toBe(400);
  expect((await api()).status).toBe(410);
});
it("cancellation racing final completion leaves no enabled relay grant", async () => {
  await begin();
  await api("claim", await claim());
  const grant = await offer();
  await api("offer", { ...grant, device: "c2VhbGVk" });
  const viewerSignature = b64(await viewer.sign(grantBytes(origin, grant)));
  const [complete, cancel] = await Promise.all([
    api("complete", { viewerSignature }),
    revoke(),
  ]);
  expect([200, 400]).toContain(complete.status);
  expect(cancel.status).toBe(200);
  expect((await api()).status).toBe(410);
});
