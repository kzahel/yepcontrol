import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { b64, createIdentity } from "../../protocol/src/index.js";
import { grantBytes, grantMac, hex, revokeBytes, verifyOffer } from "../../protocol/src/enrollment.js";
import { type PhoneInvitation, claimBytes, phoneCreateBytes, verifyClaim } from "../../protocol/src/phone-invitation.js";
const origin = "https://proof.invalid", key = crypto.randomUUID();
const directory = await mkdtemp(path.join(tmpdir(), "phone-invite-worker-"));
const mf = new Miniflare(convertV4MiniflareOptions({
  name: "phone-invite-test", modules: true, scriptPath: ".local/bundle/worker.js", compatibilityDate: "2026-10-01", cf: false,
  durableObjects: {PAIRINGS: {className: "Pairing", useSQLite: true}, ADMISSION: {className: "Admission", useSQLite: true}},
  ratelimits: {HTTP_LIMITER: {namespace_id: "340001", simple: {limit: 240, period: 60}}, START_LIMITER: {namespace_id: "340002", simple: {limit: 10, period: 60}}},
  bindings: {PUBLIC_ORIGIN: origin, PROOF_KEY: key}, resourcePersistencePath: directory,
}));
try {
  for (const cancel of [false, true]) {
    const phone = await createIdentity(), viewer = await createIdentity();
    const invite: PhoneInvitation = {v: 1, origin, id: hex(crypto.getRandomValues(new Uint8Array(16))), phone: b64(phone.publicKey), secret: hex(crypto.getRandomValues(new Uint8Array(32))), expires: Math.floor(Date.now()/1000)+300};
    const api = (action = "", value?: unknown) => mf.dispatchFetch(`${origin}/api/pair/${invite.id}${action ? `/${action}` : ""}`, {headers: {"X-Proof-Key": key, "Content-Type": "application/json"}, ...(value === undefined ? {} : {method: "POST", body: JSON.stringify(value)})});
    assert.equal((await api("invite", {phone: invite.phone, expires: invite.expires, signature: "bad"})).status, 400);
    assert.equal((await api("invite", {phone: invite.phone, expires: invite.expires, signature: b64(await phone.sign(phoneCreateBytes(origin, invite)))})).status, 201);
    await mf.unsafeEvictDurableObject("phone-invite-test", "Pairing", {name: invite.id});
    const c = {viewer: b64(viewer.publicKey), name: "Chrome on Android"};
    const bytes = claimBytes(origin, invite, c);
    const claim = {...c, signature: b64(await viewer.sign(bytes)), mac: hex(await grantMac(invite.secret, bytes))};
    assert.equal((await api("claim", {...claim, signature: "bad"})).status, 400);
    assert.deepEqual((await Promise.all([api("claim", claim), api("claim", claim)])).map(r=>r.status).sort(), [202,400]);
    const received = await (await api()).json() as {claim: typeof claim};
    await verifyClaim(invite, received.claim);
    const grant = {id: invite.id, viewer: c.viewer, phone: invite.phone, expires: invite.expires, phoneSignature: "", mac: ""};
    const g = grantBytes(origin, grant);
    grant.phoneSignature = b64(await phone.sign(g)); grant.mac = hex(await grantMac(invite.secret,g));
    assert.equal((await api("offer", {...grant, device: "c2VhbGVk"})).status, 202);
    await verifyOffer({...invite,...c}, grant);
    await mf.unsafeEvictDurableObject("phone-invite-test", "Pairing", {name: invite.id});
    const completion = {viewerSignature: b64(await viewer.sign(g))};
    const revocation = {signature: b64(await phone.sign(revokeBytes(origin, invite.id)))};
    if (cancel) {
      const results = await Promise.all([api("complete",completion),api("revoke",revocation)]);
      assert.ok([200,400].includes(results[0]!.status)); assert.equal(results[1]!.status,200);
    } else {
      assert.equal((await api("complete",completion)).status,200);
      assert.equal((await api("claim",claim)).status,400);
      assert.equal((await api("revoke",revocation)).status,200);
    }
    await mf.unsafeEvictDurableObject("phone-invite-test", "Pairing", {name: invite.id});
    assert.equal((await api()).status,410);
    assert.equal((await api("claim",claim)).status,400);
  }
  console.log("Phone-first Worker pairing passed: signed creation, claims, one winner, hibernation, v1 completion and cancellation races");
} finally { await mf.dispose(); await rm(directory,{recursive:true,force:true}); }
