import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { grantBytes } from "../../protocol/src/enrollment.js";
import { b64, createIdentity } from "../../protocol/src/index.js";
import {
  digest,
  IMPORT_BATCH_SIZE,
  type Snapshot,
  validateSnapshot,
} from "./migration.js";
const directory = await mkdtemp(path.join(tmpdir(), "yepcontrol-import-"));
const origin = "https://yepcontrol.com";
const phone = await createIdentity(),
  viewer = await createIdentity();
const snapshot: Snapshot = { version: 1, origin, rows: [] };
for (let i = 1; i <= 35; i++) {
  const grant = {
    id: String(i).padStart(32, "0"),
    viewer: b64(viewer.publicKey),
    phone: b64(phone.publicKey),
    expires: 100,
    mac: "0".repeat(64),
  };
  const grantOrigin = i === 3 ? "https://retired.invalid" : origin;
  snapshot.rows.push({
    pair: {
      ...grant,
      phoneSignature: b64(await phone.sign(grantBytes(grantOrigin, grant))),
      viewerSignature: b64(await viewer.sign(grantBytes(grantOrigin, grant))),
      revoked: i === 2,
      accessEnabled: i !== 3,
      accessGeneration: "a".repeat(32),
    },
    created: i,
    ...(i === 1
      ? { target: { fid: "c" + "a".repeat(21), generation: "a".repeat(32) } }
      : {}),
  });
}
const raw = JSON.stringify(snapshot),
  hash = await digest(raw);
function options(
  mode = "maintenance",
  expected = hash,
  expires = String(Date.now() + 60000),
) {
  const bindings = {
    PUBLIC_ORIGIN: origin,
    RELAY_MODE: mode,
    MIGRATION_SHA256: expected,
    MIGRATION_EXPIRES: expires,
  };
  return convertV4MiniflareOptions({
    resourcePersistencePath: directory,
    cf: false,
    workers: [
      {
        name: "importer",
        modules: true,
        scriptPath: ".local/migration-bundle/migration-worker.js",
        compatibilityDate: "2026-10-01",
        bindings: { ...bindings, MIGRATION_TOKEN: "test-only" },
        durableObjects: {
          PAIRINGS: {
            className: "Pairing",
            scriptName: "relay",
            useSQLite: true,
          },
          ADMISSION: {
            className: "Admission",
            scriptName: "relay",
            useSQLite: true,
          },
        },
      },
      {
        name: "relay",
        modules: true,
        scriptPath: ".local/bundle/worker.js",
        compatibilityDate: "2026-10-01",
        bindings,
        serviceBindings: {
          ASSETS: async (request: Request) =>
            new Response(new URL(request.url).pathname),
        },
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
      },
    ],
  });
}
let mf = new Miniflare(options());
const send = (body = raw, token = "test-only", offset = 0) =>
  mf.dispatchFetch(`https://import.invalid/import?offset=${offset}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
  });
try {
  assert.equal((await send(raw, "wrong")).status, 404);
  assert.equal(
    (await send(raw + " ")).status,
    409,
    "Only the exact frozen snapshot is admitted",
  );
  assert.equal((await mf.listDurableObjectIds("PAIRINGS", "relay")).length, 0);
  const relay = await mf.getWorker("relay");
  assert.equal(
    (await relay.fetch(origin + "/api/pair/" + snapshot.rows[0]!.pair.id))
      .status,
    503,
  );
  assert.equal(
    (await send(raw, "test-only", IMPORT_BATCH_SIZE)).status,
    409,
    "Cannot skip a batch",
  );
  assert.equal(
    (await send(raw, "test-only", 1)).status,
    409,
    "Invalid batch boundary",
  );
  const first = await send();
  assert.equal(first.status, 200, "Real cross-Worker RPC batch");
  assert.deepEqual(await first.json(), {
    sha256: hash,
    nextOffset: IMPORT_BATCH_SIZE,
    verified: false,
  });
  await mf.dispose();
  mf = new Miniflare(options());
  // Repeat the acknowledged batch, then resume after a full process restart.
  assert.equal((await send()).status, 200);
  assert.equal((await send(raw, "test-only", IMPORT_BATCH_SIZE)).status, 200);
  assert.deepEqual(
    await (await send(raw, "test-only", IMPORT_BATCH_SIZE * 2)).json(),
    {
      sha256: hash,
      pairs: 35,
      revoked: 1,
      paused: 1,
      targets: 1,
      verified: true,
    },
  );
  await mf.dispose();
  mf = new Miniflare(options());
  assert.equal(
    (await send(raw, "test-only", IMPORT_BATCH_SIZE * 2)).status,
    200,
    "Identical completed import resumes after a full runtime restart",
  );
  await mf.dispose();
  const altered = structuredClone(snapshot);
  altered.rows[1]!.pair.revoked = false;
  mf = new Miniflare(
    options("maintenance", await digest(JSON.stringify(altered))),
  );
  assert.equal(
    (await send(JSON.stringify(altered))).status,
    409,
    "Cannot replace imported authority even with a new authorized manifest",
  );
  await mf.dispose();
  mf = new Miniflare(options("maintenance", hash, "1"));
  assert.equal((await send()).status, 409, "Expired imports refuse");
  await mf.dispose();
  mf = new Miniflare(options("production"));
  assert.equal(
    (await send()).status,
    409,
    "Migration is disabled in production",
  );
  const live = await mf.getWorker("relay");
  for (const [route, asset] of [
    ["/", "/index.html"],
    ["/enroll", "/install.html"],
    ["/install", "/install.html"],
    ["/phones", "/viewer.html"],
    ["/pair", "/viewer.html"],
    ["/robots.txt", "/robots.txt"],
    ["/sitemap.xml", "/sitemap.xml"],
    ["/.well-known/assetlinks.json", "/.well-known/assetlinks.json"],
  ]) {
    const response = await live.fetch(origin + route);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), asset);
  }
  const health = await live.fetch(origin + "/health");
  assert.equal(
    ((await health.json()) as { admission: string }).admission,
    "public",
  );
  assert.ok(
    health.headers
      .get("Content-Security-Policy")
      ?.includes("frame-ancestors 'none'"),
  );
  assert.equal(
    health.headers.get("Strict-Transport-Security"),
    "max-age=31536000",
  );
  for (const row of snapshot.rows) {
    const response = await live.fetch(origin + "/api/pair/" + row.pair.id);
    assert.equal(response.status, row.pair.revoked ? 410 : 200);
    if (!row.pair.revoked)
      assert.deepEqual(
        ((await response.json()) as { grant: unknown }).grant,
        row.pair,
      );
  }
  assert.equal(
    (await live.fetch(origin + "/_proof/" + snapshot.rows[0]!.pair.id)).status,
    404,
  );
  assert.equal((await live.fetch("https://wrong.invalid/")).status, 421);
  assert.equal(
    (
      await live.fetch("https://www.yepcontrol.com/privacy/?test=1", {
        redirect: "manual",
      })
    ).headers.get("Location"),
    origin + "/privacy/?test=1",
  );
  const duplicate = structuredClone(snapshot);
  duplicate.rows.push(duplicate.rows[0]!);
  await assert.rejects(validateSnapshot(duplicate, origin));
  const invalid = structuredClone(snapshot);
  invalid.rows[0]!.pair.phoneSignature = "invalid";
  await assert.rejects(validateSnapshot(invalid, origin));
  await assert.rejects(validateSnapshot(snapshot, "https://different.invalid"));
  console.log(
    "Production gate, headers, frozen authority import, idempotence, refusal and restart persistence passed",
  );
} finally {
  await mf.dispose();
  await rm(directory, { recursive: true, force: true });
}
