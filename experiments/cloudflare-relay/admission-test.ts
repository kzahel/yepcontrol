import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { createBytes, hex } from "../../protocol/src/enrollment.js";
import { b64, createIdentity } from "../../protocol/src/index.js";

const directory = await mkdtemp(path.join(tmpdir(), "yepcontrol-admission-"));
const origin = "https://proof.invalid";
const key = crypto.randomUUID();
const identity = await createIdentity();
function configuration(capacity = "3", starts = "2") {
  return convertV4MiniflareOptions({
    name: "admission-test",
    modules: true,
    scriptPath: ".local/bundle/worker.js",
    compatibilityDate: "2026-10-01",
    cf: false,
    durableObjects: {
      PAIRINGS: { className: "Pairing", useSQLite: true },
      ADMISSION: { className: "Admission", useSQLite: true },
    },
    ratelimits: {
      HTTP_LIMITER: {
        namespace_id: "340001",
        simple: { limit: 240, period: 60 },
      },
      START_LIMITER: {
        namespace_id: "340002",
        simple: { limit: 10, period: 60 },
      },
    },
    bindings: {
      PUBLIC_ORIGIN: origin,
      PROOF_KEY: key,
      PAIRING_CAPACITY: capacity,
      PAIRING_STARTS_PER_HOUR: starts,
      REQUESTS_PER_MINUTE: "100",
      SOCKET_CAPACITY: "2",
    },
    resourcePersistencePath: directory,
  });
}
let mf = new Miniflare(configuration());
const id = () => hex(crypto.getRandomValues(new Uint8Array(16)));
async function create(
  route: string,
  signature?: string,
  ip = "local",
  expires = Math.floor(Date.now() / 1000) + 300,
) {
  const invitation = {
    id: route,
    viewer: b64(identity.publicKey),
    expires,
  };
  return mf.dispatchFetch(`${origin}/api/pair/${route}`, {
    method: "POST",
    headers: {
      "X-Proof-Key": key,
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
    },
    body: JSON.stringify({
      ...invitation,
      signature:
        signature ?? b64(await identity.sign(createBytes(origin, invitation))),
    }),
  });
}
try {
  const deadlineResponse = await mf.dispatchFetch(`${origin}/api/pairing-time`, {headers: {"X-Proof-Key": key}});
  assert.equal(deadlineResponse.status, 200);
  assert.equal(deadlineResponse.headers.get("Cache-Control"), "no-store");
  const deadline = await deadlineResponse.json() as {serverTime: number; expires: number};
  assert.ok(Number.isSafeInteger(deadline.serverTime));
  assert.ok(deadline.expires * 1000 > deadline.serverTime);
  assert.ok(deadline.expires * 1000 <= deadline.serverTime + 300000);
  assert.equal((await mf.listDurableObjectIds("PAIRINGS")).length, 0);
  // Valid-looking random reads and upgrades must not allocate Pairing objects.
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await mf.dispatchFetch(`${origin}/api/pair/${id()}`, {
      headers: { "X-Proof-Key": key },
    });
    assert.equal(response.status, 404);
  }
  assert.equal(
    (
      await mf.dispatchFetch(`${origin}/api/socket?id=${id()}`, {
        headers: { "X-Proof-Key": key, Upgrade: "websocket" },
      })
    ).status,
    404,
  );
  const first = id();
  for (const offset of [303, -300]) {
    const clockError = await create(
      first,
      undefined,
      "clock",
      Math.floor(Date.now() / 1000) + offset,
    );
    assert.equal(clockError.status, 400);
    const detail = (await clockError.json()) as {
      error: string;
      serverTime: number;
    };
    assert.equal(detail.error, "clock-skew");
    assert.ok(Math.abs(detail.serverTime - Date.now()) < 5000);
    assert.equal(
      (await mf.listDurableObjectIds("PAIRINGS")).length,
      0,
      "Clock rejection must not allocate authority before a retry",
    );
  }
  const invalidSignature = await create(id(), "invalid");
  assert.equal(invalidSignature.status, 400);
  assert.deepEqual(await invalidSignature.json(), {error: "invalid-signature"});
  assert.equal((await mf.listDurableObjectIds("PAIRINGS")).length, 0);
  const starts = await Promise.all([
    create(first, undefined, "local", deadline.expires),
    create(first, undefined, "local", deadline.expires),
  ]);
  assert.deepEqual(starts.map((r) => r.status).sort(), [201, 400]);
  assert.equal((await create(id())).status, 201);
  const refused = await create(id());
  assert.equal(refused.status, 429);
  assert.ok(refused.headers.has("Retry-After"));
  assert.equal((await mf.listDurableObjectIds("PAIRINGS")).length, 2);
  await mf.unsafeEvictDurableObject("admission-test", "Admission", {
    name: "global",
  });
  assert.equal((await create(id())).status, 429, "Admission survives eviction");
  await mf.dispose();
  // Raise only the hourly bound: the independent lifetime cap must still refuse.
  mf = new Miniflare(configuration("2", "3"));
  assert.equal(
    (await create(id())).status,
    429,
    "Admission survives runtime restart",
  );
  assert.equal(
    (
      await mf.dispatchFetch(`${origin}/api/pair/${first}`, {
        headers: { "X-Proof-Key": key },
      })
    ).status,
    200,
    "Existing authority stays reachable at capacity",
  );
  const admission = await mf.getDurableObjectNamespace("ADMISSION");
  const stub = admission.get(admission.idFromName("global"));
  const upgrade = () =>
    stub.fetch("https://admission.invalid/", {
      method: "POST",
      body: JSON.stringify({ id: first, upgrade: true, create: false }),
    });
  const release = (response: {
    headers: { get(name: string): string | null };
  }) =>
    stub.fetch("https://admission.invalid/release", {
      method: "POST",
      body: JSON.stringify({ lease: response.headers.get("X-Relay-Lease") }),
    });
  // A rejected HTTP upgrade must give back its connection lease.
  assert.equal(
    (
      await mf.dispatchFetch(`${origin}/api/socket?id=${first}`, {
        headers: { "X-Proof-Key": key },
      })
    ).status,
    429,
  );
  const one = await upgrade(),
    two = await upgrade();
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  await mf.unsafeEvictDurableObject("admission-test", "Admission", {
    name: "global",
  });
  assert.equal(
    (await upgrade()).status,
    429,
    "Connection capacity survives eviction",
  );
  await release(one);
  await release(one); // Idempotent close cannot release another socket.
  const three = await upgrade();
  assert.equal(three.status, 200);
  assert.equal((await upgrade()).status, 429);
  await release(two);
  await release(three);
  // Unknown, refused and failed upgrades also consumed rate permits (seven above).
  for (let attempt = 0; attempt < 53; attempt++) {
    const response = await upgrade();
    assert.equal(response.status, 200);
    await release(response);
  }
  assert.equal((await upgrade()).status, 429, "Strict global upgrade budget");
  await mf.unsafeEvictDurableObject("admission-test", "Admission", {
    name: "global",
  });
  assert.equal((await upgrade()).status, 429);
  let denied = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await stub.fetch("https://admission.invalid/", {
      method: "POST",
      body: JSON.stringify({ id: id(), create: false, upgrade: false }),
    });
    assert.ok(response.status === 404 || response.status === 429);
    if (response.status === 429) denied = true;
    if (denied)
      assert.equal(response.status, 429, "Strict global request budget");
  }
  assert.ok(denied);
  await mf.unsafeEvictDurableObject("admission-test", "Admission", {
    name: "global",
  });
  assert.equal(
    (
      await stub.fetch("https://admission.invalid/", {
        method: "POST",
        body: JSON.stringify({ id: first, create: false, upgrade: false }),
      })
    ).status,
    429,
  );
  for (let attempt = 0; attempt < 10; attempt++)
    assert.equal((await create(id(), "invalid", "192.0.2.2")).status, 400);
  assert.equal(
    (await create(id(), "invalid", "192.0.2.2")).status,
    429,
    "Edge pairing-start budget includes invalid signatures",
  );
  for (let attempt = 0; attempt < 240; attempt++)
    assert.equal(
      (
        await mf.dispatchFetch(`${origin}/api/missing`, {
          headers: { "X-Proof-Key": key, "CF-Connecting-IP": "192.0.2.3" },
        })
      ).status,
      404,
    );
  assert.equal(
    (
      await mf.dispatchFetch(`${origin}/api/missing`, {
        headers: { "X-Proof-Key": key, "CF-Connecting-IP": "192.0.2.3" },
      })
    ).status,
    429,
    "Edge request budget",
  );
  assert.equal((await mf.listDurableObjectIds("PAIRINGS")).length, 2);
  console.log(
    "Cloudflare admission passed: unknown-ID isolation, concurrent reservation, capacity, durable quotas and existing-route access.",
  );
} finally {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
}
