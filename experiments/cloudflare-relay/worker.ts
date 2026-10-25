/** Hosted relay. Production and the closed proof use separate Workers/state. */
import { DurableObject } from "cloudflare:workers";
import { viewerAssetPath } from "../../web/routes.js";
import {
  authBytes,
  createBytes,
  fromHex,
  type Grant,
  grantBytes,
  hex,
  revokeBytes,
  verifySignature,
} from "../../protocol/src/enrollment.js";
import type { Admission } from "./admission.js";
import { deliverFcm } from "./fcm.js";
import { FcmAuth, type FcmToken, type TokenStore } from "./fcm-auth.js";
import { acknowledge, type Flow, forward, freshFlow, receive } from "./flow.js";
import {
  digest,
  requireMigration,
  type MigrationRow,
  validateRow,
} from "./migration.js";

export { Admission } from "./admission.js";

type Env = {
  PAIRINGS: DurableObjectNamespace<Pairing>;
  ADMISSION: DurableObjectNamespace<Admission>;
  HTTP_LIMITER: RateLimit;
  START_LIMITER: RateLimit;
  PUBLIC_ORIGIN: string;
  ASSETS?: Fetcher;
  WAKE_BUDGET?: DurableObjectNamespace;
  FCM_PROJECT?: string;
  FCM_SERVICE_ACCOUNT?: string;
  PROOF_KEY?: string;
  PROOF_EXPIRES?: string;
  PROOF_BUILD?: string;
  RELEASE_VERSION?: string;
  REVISION?: string;
  CF_VERSION_METADATA?: { id: string };
  RELAY_MODE?: string;
  MIGRATION_SHA256?: string;
  MIGRATION_EXPIRES?: string;
};
type Pair = Grant & {
  viewerSignature: string;
  revoked: boolean;
  accessEnabled?: boolean;
  accessGeneration?: string;
};
type Target = { fid: string; generation?: string };
type Wake = {
  requestId: string;
  expires: number;
  viewer: string;
  retryAt?: number;
};
type Pending = {
  id: string;
  viewer: string;
  expires: number;
  offer?: Grant;
  device?: string;
};
type Attachment = {
  nonce: string;
  deadline: number;
  session: string;
  management?: boolean;
  policyUpdated?: boolean;
  pushUpdated?: boolean;
  working?: boolean;
  role?: "phone" | "viewer";
  flow: Flow;
  lease: string;
};
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
async function body(
  req: Pick<Request, "headers" | "body">,
  limit = 4096,
): Promise<Record<string, unknown>> {
  if (req.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new Error("JSON required");
  const reader = req.body?.getReader();
  if (!reader) throw new Error("Body required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    if (length > limit) {
      await reader.cancel();
      throw new Error("Body too large");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 1600)
    throw new Error("Invalid field");
  return value;
}
const worker = {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (env.RELAY_MODE && url.hostname === "www.yepcontrol.com")
      return Response.redirect(
        `https://yepcontrol.com${url.pathname}${url.search}`,
        308,
      );
    // Public deployment identity only; no pairing lookup, wake or object allocation.
    if (url.pathname === "/health" && req.method === "GET")
      return json({
        status: "ok",
        version: env.RELEASE_VERSION ?? "development",
        revision: env.REVISION ?? "development",
        deployment: env.CF_VERSION_METADATA?.id ?? null,
        admission:
          env.RELAY_MODE === "production"
            ? "public"
            : env.RELAY_MODE === "maintenance"
              ? "maintenance"
              : env.PROOF_KEY &&
                  (env.PROOF_EXPIRES === undefined ||
                    (Number.isFinite(Number(env.PROOF_EXPIRES)) &&
                      Date.now() < Number(env.PROOF_EXPIRES)))
                ? "gated"
                : "closed",
      });
    // A fixture gate, NOT the proposed production enrollment defense.
    if (
      env.RELAY_MODE === "maintenance" &&
      (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_proof/"))
    )
      return new Response(
        JSON.stringify({ error: "Relay maintenance; reconnect shortly" }),
        {
          status: 503,
          headers: { "Content-Type": "application/json", "Retry-After": "60" },
        },
      );
    if (env.RELAY_MODE && url.origin !== env.PUBLIC_ORIGIN)
      return json({ error: "Use the canonical origin" }, 421);
    if (
      env.RELAY_MODE !== "production" &&
      env.RELAY_MODE !== "maintenance" &&
      (!env.PROOF_KEY ||
        (req.headers.get("X-Proof-Key") ??
          req.headers
            .get("Cookie")
            ?.match(
              /(?:^|;\s*)__Host-yepcontrol-proof=([0-9a-f]{64})(?:;|$)/,
            )?.[1]) !== env.PROOF_KEY ||
        (env.PROOF_EXPIRES !== undefined &&
          (!Number.isFinite(Number(env.PROOF_EXPIRES)) ||
            Date.now() >= Number(env.PROOF_EXPIRES))))
    )
      return json({ error: "Proof only" }, 403);
    if (
      req.headers.has("Origin") &&
      req.headers.get("Origin") !== env.PUBLIC_ORIGIN
    )
      return json({ error: "Origin" }, 403);
    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/_proof/")
    ) {
      if (!env.HTTP_LIMITER || !env.START_LIMITER || !env.ADMISSION)
        return json({ error: "Admission unavailable" }, 503);
      // Cloudflare supplies this header at ingress; forwarded user headers are not trusted.
      const key = req.headers.get("CF-Connecting-IP") ?? "local";
      const start =
        req.method === "POST" &&
        /^\/api\/pair\/[0-9a-f]{32}$/.test(url.pathname);
      if (
        !(await env.HTTP_LIMITER.limit({ key })).success ||
        (start && !(await env.START_LIMITER.limit({ key })).success)
      )
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "60", "Cache-Control": "no-store" },
        });
    }
    if (
      !url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/_proof/")
    ) {
      if (!env.ASSETS) return json({ error: "No viewer" }, 404);
      url.pathname = viewerAssetPath(url.pathname);
      return env.ASSETS.fetch(new Request(url, req));
    }
    const api = url.pathname.match(
      /^\/api\/pair\/([0-9a-f]{32})(?:\/(offer|complete|revoke))?$/,
    );
    const diagnostic = url.pathname.match(/^\/_proof\/([0-9a-f]{32})$/);
    if (env.RELAY_MODE && diagnostic) return json({ error: "Route" }, 404);
    const id =
      api?.[1] ??
      diagnostic?.[1] ??
      (url.pathname === "/api/socket" ? url.searchParams.get("id") : null);
    if (!id || !/^[0-9a-f]{32}$/.test(id)) return json({ error: "Route" }, 404);
    try {
      let forward = req;
      if (api && !api[2] && req.method === "POST") {
        // Reject malformed/unsigned enrollment before allocating a billable object.
        const value = await body(req);
        const viewer = text(value.viewer);
        const expires = Number(value.expires);
        if (
          !Number.isSafeInteger(value.expires) ||
          expires * 1000 <= Date.now() ||
          expires * 1000 > Date.now() + 301000
        )
          throw new Error("Expiry");
        await verifySignature(
          viewer,
          createBytes(env.PUBLIC_ORIGIN, { id, viewer, expires }),
          text(value.signature),
        );
        forward = new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: JSON.stringify(value),
        });
      }
      const admitted = await env.ADMISSION.getByName("global").fetch(
        "https://admission.invalid/",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            create: Boolean(api && !api[2] && req.method === "POST"),
            upgrade: url.pathname === "/api/socket",
          }),
        },
      );
      if (!admitted.ok) return admitted;
      const lease = admitted.headers.get("X-Relay-Lease");
      const routed = new Request(forward);
      routed.headers.delete("X-Relay-Lease");
      if (lease) routed.headers.set("X-Relay-Lease", lease);
      let result: Response | undefined;
      try {
        result = await env.PAIRINGS.getByName(id).fetch(routed);
        return result;
      } finally {
        if (lease && result?.status !== 101)
          await env.ADMISSION.getByName("global").fetch(
            "https://admission.invalid/release",
            {
              method: "POST",
              body: JSON.stringify({ lease }),
            },
          );
      }
    } catch {
      return json({ error: "Rejected" }, 400);
    }
  },
} satisfies ExportedHandler<Env>;

export default {
  async fetch(req: Request, env: Env) {
    const response = await worker.fetch(req, env);
    if (response.status === 101) return response;
    const secured = new Response(response.body, response);
    for (const [name, value] of Object.entries({
      "Strict-Transport-Security": "max-age=31536000",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Cache-Control": "no-store",
    }))
      secured.headers.set(name, value);
    return secured;
  },
} satisfies ExportedHandler<Env>;

export class Pairing extends DurableObject<Env> {
  private readonly boot = crypto.randomUUID();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  private get<T>(key: string): T | undefined {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  private put(key: string, value: unknown) {
    this.ctx.storage.sql.exec(
      "INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  private drop(key: string) {
    this.ctx.storage.sql.exec("DELETE FROM state WHERE key = ?", key);
  }
  /** Internal RPC only; disabled in every normal production/staging deployment. */
  async importState(row: MigrationRow, manifest: string): Promise<string> {
    requireMigration(this.env, manifest);
    await validateRow(row, this.env.PUBLIC_ORIGIN);
    const hash = await digest(JSON.stringify(row));
    requireMigration(this.env, manifest);
    this.ctx.storage.transactionSync(() => {
      const marker = this.get<{
        manifest: string;
        hash: string;
        created: number;
      }>("imported");
      if (marker) {
        if (marker.manifest !== manifest || marker.hash !== hash)
          throw new Error("Different import");
        return;
      }
      if (
        this.ctx.storage.sql.exec("SELECT key FROM state LIMIT 1").toArray()
          .length ||
        this.ctx.getWebSockets().length
      )
        throw new Error("Destination is not empty");
      this.put("pair", row.pair);
      if (row.target) this.put("target", row.target);
      this.put("imported", { manifest, hash, created: row.created });
    });
    const target = this.get<Target>("target");
    const observed = await digest(
      JSON.stringify({
        pair: this.get<Pair>("pair"),
        created: row.created,
        ...(target ? { target } : {}),
      }),
    );
    if (observed !== hash) throw new Error("Imported authority changed");
    return observed;
  }
  private sockets(role?: string) {
    return this.ctx
      .getWebSockets()
      .filter(
        (ws) =>
          ws.readyState === WebSocket.OPEN &&
          (!role ||
            ((ws.deserializeAttachment() as Attachment).role === role &&
              !(ws.deserializeAttachment() as Attachment).management)),
      );
  }
  private disconnect(viewerCode = 4001) {
    this.drop("wake");
    for (const ws of this.sockets()) {
      const attachment = ws.deserializeAttachment() as Attachment;
      if (attachment.role && !attachment.management)
        ws.close(attachment.role === "viewer" ? viewerCode : 4001, "Reconnect");
    }
  }
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/_proof/") && req.method === "GET") {
      return json({
        boot: this.boot,
        build: this.env.PROOF_BUILD ?? "local",
        sockets: this.ctx.getWebSockets().length,
        authenticated: this.sockets().filter(
          (ws) => (ws.deserializeAttachment() as Attachment).role !== undefined,
        ).length,
        revoked: this.get<Pair>("pair")?.revoked ?? false,
      });
    }
    if (url.pathname === "/api/socket") {
      const lease = req.headers.get("X-Relay-Lease");
      if (
        req.headers.get("Upgrade") !== "websocket" ||
        !lease ||
        this.ctx.getWebSockets().length >= 8
      )
        return json({ error: "Unavailable" }, 429);
      const pair = new WebSocketPair();
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        session: crypto.randomUUID(),
        nonce: hex(crypto.getRandomValues(new Uint8Array(32))),
        deadline: Date.now() + 10000,
        flow: freshFlow(),
        lease,
      } satisfies Attachment);
      const attachment = server.deserializeAttachment() as Attachment;
      server.send(
        JSON.stringify({
          type: "challenge",
          nonce: attachment.nonce,
          relayFlow: 1,
        }),
      );
      await this.schedule();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const id = url.pathname.split("/")[3] ?? "";
    const action = url.pathname.split("/")[4];
    try {
      const paired = this.get<Pair>("pair");
      const pending = this.get<Pending>("pending");
      if (req.method === "GET" && !action) {
        if (paired?.revoked) return json({ error: "Unavailable" }, 410);
        if (paired) return json({ state: "paired", grant: paired });
        if (pending && pending.expires * 1000 > Date.now())
          return json(
            pending.offer
              ? {
                  state: "offered",
                  grant: pending.offer,
                  device: pending.device,
                }
              : { state: "waiting" },
          );
        return json({ error: "Unavailable" }, 404);
      }
      if (req.method !== "POST") return json({ error: "Method" }, 405);
      const value = await body(req);
      if (!action) {
        if (
          this.get<Pair>("pair") ||
          (this.get<Pending>("pending")?.expires ?? 0) * 1000 > Date.now()
        )
          throw new Error("Duplicate");
        if (Number(value.expires) * 1000 <= Date.now())
          throw new Error("Expired");
        // The front Worker already verified the creation signature and expiry.
        this.put("pending", {
          id,
          viewer: text(value.viewer),
          expires: value.expires,
        });
        await this.schedule();
        return json({ state: "waiting" }, 201);
      }
      if (action === "revoke") {
        if (!paired) throw new Error("No pair");
        await verifySignature(
          paired.phone,
          revokeBytes(this.env.PUBLIC_ORIGIN, id),
          text(value.signature),
        );
        const latest = this.get<Pair>("pair");
        if (!latest) throw new Error("No pair");
        this.ctx.storage.transactionSync(() => {
          this.put("pair", { ...latest, revoked: true });
          this.drop("target");
          this.drop("wake");
        });
        this.disconnect(4010);
        return json({ state: "revoked" });
      }
      if (paired || !pending || pending.expires * 1000 <= Date.now())
        throw new Error("No invitation");
      if (action === "offer") {
        const offer: Grant = {
          id,
          viewer: pending.viewer,
          expires: pending.expires,
          phone: text(value.phone),
          phoneSignature: text(value.phoneSignature),
          mac: text(value.mac),
        };
        fromHex(offer.mac, 32);
        const device = text(value.device);
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(device)) throw new Error("Device");
        await verifySignature(
          offer.phone,
          grantBytes(this.env.PUBLIC_ORIGIN, offer),
          offer.phoneSignature,
        );
        // Re-read after await: DO input gates do not serialize arbitrary crypto awaits.
        const latest = this.get<Pending>("pending");
        if (
          !latest ||
          latest.offer ||
          this.get<Pair>("pair") ||
          latest.expires * 1000 <= Date.now()
        )
          throw new Error("Stale");
        this.put("pending", { ...latest, offer, device });
        return json({ state: "offered" }, 202);
      }
      if (action !== "complete" || !pending.offer) throw new Error("No offer");
      const viewerSignature = text(value.viewerSignature);
      await verifySignature(
        pending.viewer,
        grantBytes(this.env.PUBLIC_ORIGIN, pending.offer),
        viewerSignature,
      );
      const latest = this.get<Pending>("pending");
      if (
        !latest?.offer ||
        this.get<Pair>("pair") ||
        latest.expires * 1000 <= Date.now()
      )
        throw new Error("Stale");
      this.ctx.storage.transactionSync(() => {
        this.put("pair", { ...latest.offer, viewerSignature, revoked: false });
        this.drop("pending");
      });
      return json({ state: "paired", grant: this.get<Pair>("pair") });
    } catch {
      return json({ error: "Rejected" }, 400);
    }
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      let attachment = ws.deserializeAttachment() as Attachment;
      const pair = this.get<Pair>("pair");
      if (!pair) throw new Error("Unavailable");
      if (!attachment.role) {
        if (
          attachment.working ||
          typeof message !== "string" ||
          message.length > 2048 ||
          attachment.deadline <= Date.now()
        )
          throw new Error("Auth");
        ws.serializeAttachment({ ...attachment, working: true });
        const auth = JSON.parse(message);
        if (
          auth.id !== pair.id ||
          (auth.role !== "phone" && auth.role !== "viewer")
        )
          throw new Error("Role");
        const role = auth.role as "phone" | "viewer";
        await verifySignature(
          pair[role],
          authBytes(this.env.PUBLIC_ORIGIN, pair.id, role, attachment.nonce),
          auth.signature,
        );
        const latest = this.get<Pair>("pair");
        if (latest?.revoked && role === "viewer") {
          ws.close(4010, "Access removed");
          return;
        }
        if (
          !latest ||
          latest.revoked ||
          attachment.deadline <= Date.now() ||
          ws.readyState !== WebSocket.OPEN ||
          !this.ctx.getWebSockets().includes(ws)
        )
          throw new Error("Stale");
        const management = auth.mode !== undefined;
        if (management) {
          if (
            role !== "phone" ||
            auth.mode !== "registration" ||
            auth.requestId !== undefined ||
            this.sockets().some((peer) => {
              const value = peer.deserializeAttachment() as Attachment;
              return value.role === "phone" && value.management;
            })
          )
            throw new Error("Management");
        } else {
          if (latest.accessEnabled === false && role === "viewer") {
            ws.close(4011, "Access paused");
            return;
          }
          if (
            latest.accessEnabled === false ||
            (role === "phone" &&
              latest.accessGeneration !== undefined &&
              auth.generation !== latest.accessGeneration) ||
            this.sockets(role).length
          )
            throw new Error("Access or duplicate");
          if (auth.requestId !== undefined) {
            const wake = this.get<Wake>("wake"),
              viewer = this.sockets("viewer")[0];
            if (
              role !== "phone" ||
              !wake ||
              !viewer ||
              wake.requestId !== auth.requestId ||
              wake.expires * 1000 <= Date.now() ||
              (viewer.deserializeAttachment() as Attachment).session !==
                wake.viewer
            )
              throw new Error("Stale wake");
          }
        }
        attachment = {
          ...attachment,
          role,
          management,
          deadline: Date.now() + 3600000,
        };
        ws.serializeAttachment(attachment);
        ws.send(JSON.stringify({ type: "authenticated" }));
        if (!management) {
          if (this.sockets("phone").length && this.sockets("viewer").length) {
            this.drop("wake");
            for (const peer of [
              ...this.sockets("phone"),
              ...this.sockets("viewer"),
            ])
              peer.send(JSON.stringify({ type: "ready" }));
          } else if (
            role === "viewer" &&
            this.env.FCM_SERVICE_ACCOUNT &&
            this.env.FCM_PROJECT
          ) {
            this.put("wake", {
              requestId: hex(crypto.getRandomValues(new Uint8Array(16))),
              expires: Math.floor(Date.now() / 1000) + 60,
              viewer: attachment.session,
            });
            await this.attemptWake();
          }
        }
        await this.schedule();
        return;
      }
      if (pair.revoked || attachment.deadline <= Date.now())
        throw new Error("Unavailable");
      if (typeof message === "string" && message.length > 512)
        throw new Error("Metadata size");
      attachment = {
        ...attachment,
        flow: receive(
          attachment.flow,
          typeof message === "string"
            ? new TextEncoder().encode(message).length
            : message.byteLength,
          Date.now(),
        ),
      };
      ws.serializeAttachment(attachment);
      if (typeof message === "string") {
        if (!attachment.management && message.length <= 256) {
          const ack = JSON.parse(message);
          if (ack.type === "relayAck") {
            ws.serializeAttachment({
              ...attachment,
              flow: this.receipt(ws, acknowledge(attachment.flow, ack.nonce)),
            });
            return;
          }
        }
        if (attachment.role !== "phone" || message.length > 512)
          throw new Error("Metadata");
        const value = JSON.parse(message);
        if (value.type === "setAccess") {
          if (
            !attachment.management ||
            attachment.policyUpdated ||
            typeof value.enabled !== "boolean" ||
            typeof value.generation !== "string"
          )
            throw new Error("Policy");
          fromHex(value.generation, 16);
          if (
            pair.accessGeneration !== value.generation ||
            pair.accessEnabled !== value.enabled
          ) {
            const first = pair.accessGeneration === undefined;
            this.ctx.storage.transactionSync(() => {
              this.put("pair", {
                ...pair,
                accessEnabled: value.enabled,
                accessGeneration: value.generation,
              });
              if (!first || !value.enabled) this.drop("target");
            });
            if (!first || !value.enabled)
              this.disconnect(value.enabled ? 4001 : 4011);
          }
          ws.serializeAttachment({ ...attachment, policyUpdated: true });
          ws.send(JSON.stringify({ type: "accessUpdated" }));
          return;
        }
        if (attachment.pushUpdated) throw new Error("Already registered");
        if (value.type === "registerPush") {
          if (
            typeof value.fid !== "string" ||
            !/^[cdef][A-Za-z0-9_-]{21}$/.test(value.fid)
          )
            throw new Error("Target");
          this.put("target", {
            fid: value.fid,
            ...(pair.accessGeneration
              ? { generation: pair.accessGeneration }
              : {}),
          });
        } else if (value.type === "unregisterPush") this.drop("target");
        else throw new Error("Metadata");
        ws.serializeAttachment({ ...attachment, pushUpdated: true });
        ws.send(
          JSON.stringify({
            type:
              value.type === "registerPush" ? "pushRegistered" : "pushRemoved",
          }),
        );
        return;
      }
      if (
        attachment.management ||
        pair.accessEnabled === false ||
        message.byteLength > 1048608
      )
        throw new Error("Record");
      const peer = this.sockets(
        attachment.role === "phone" ? "viewer" : "phone",
      )[0];
      if (!peer) throw new Error("Peer");
      const receiver = peer.deserializeAttachment() as Attachment;
      const flow = forward(receiver.flow, message.byteLength);
      peer.send(message);
      peer.serializeAttachment({ ...receiver, flow: this.receipt(peer, flow) });
    } catch {
      if (
        (ws.deserializeAttachment() as Attachment).role &&
        !(ws.deserializeAttachment() as Attachment).management
      )
        this.disconnect();
      ws.close(4003, "Rejected");
    }
  }
  private receipt(ws: WebSocket, flow: Flow): Flow {
    if (flow.checkpoint || flow.sentRecords === flow.ackedRecords) return flow;
    const checkpoint = {
      nonce: hex(crypto.getRandomValues(new Uint8Array(16))),
      bytes: flow.sentBytes,
      records: flow.sentRecords,
    };
    // Sent AFTER its covered records on this same ordered socket. A colluding
    // sender cannot invent credit without the receiver reading those bytes.
    ws.send(JSON.stringify({ type: "relayReceipt", nonce: checkpoint.nonce }));
    return { ...flow, checkpoint };
  }
  async webSocketClose(ws: WebSocket, code: number) {
    const attachment = ws.deserializeAttachment() as Attachment;
    if (
      attachment.role &&
      !attachment.management &&
      this.sockets(attachment.role).length === 0
    )
      this.disconnect();
    // 1005/1006 are observations, never legal close-frame status codes.
    ws.close([1004, 1005, 1006, 1015].includes(code) ? 1000 : code);
    await this.release(attachment.lease);
    await this.schedule();
  }
  async webSocketError(ws: WebSocket) {
    ws.close(1011, "Transport");
    await this.release((ws.deserializeAttachment() as Attachment).lease);
  }
  private async release(lease: string) {
    await this.env.ADMISSION.getByName("global").fetch(
      "https://admission.invalid/release",
      {
        method: "POST",
        body: JSON.stringify({ lease }),
      },
    );
  }
  private async attemptWake() {
    const wake = this.get<Wake>("wake"),
      viewer = this.sockets("viewer")[0],
      pair = this.get<Pair>("pair"),
      target = this.get<Target>("target");
    if (
      !wake ||
      !viewer ||
      (viewer.deserializeAttachment() as Attachment).session !== wake.viewer ||
      this.sockets("phone").length ||
      !pair ||
      pair.revoked ||
      pair.accessEnabled === false
    ) {
      this.drop("wake");
      return;
    }
    if (wake.expires * 1000 <= Date.now()) {
      this.disconnect();
      return;
    }
    if (!target) {
      this.put("wake", { ...wake, retryAt: undefined });
      viewer.send(
        JSON.stringify({ type: "contacting", delivery: "unregistered" }),
      );
      return;
    }
    const until = this.get<number>("cooldown") ?? 0;
    if (until > Date.now()) {
      this.put("wake", { ...wake, retryAt: until });
      viewer.send(
        JSON.stringify({ type: "contacting", delivery: "coalesced" }),
      );
      return;
    }
    this.put("wake", { ...wake, retryAt: undefined });
    this.put("cooldown", Date.now() + 30000);
    let delivery: "accepted" | "invalid_target" | "unavailable" = "unavailable";
    try {
      const budget = await this.env.WAKE_BUDGET?.getByName("global").fetch(
        "https://budget.invalid/",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fid: target.fid }),
        },
      );
      const token = budget?.ok
        ? ((await budget.json()) as { token: FcmToken }).token
        : undefined;
      const latest = this.get<Wake>("wake"),
        authority = this.get<Pair>("pair");
      if (
        !latest ||
        latest.requestId !== wake.requestId ||
        !authority ||
        authority.revoked ||
        authority.accessEnabled === false ||
        this.sockets("phone").length ||
        viewer.readyState !== WebSocket.OPEN ||
        !this.sockets("viewer").includes(viewer) ||
        latest.expires * 1000 <= Date.now() ||
        this.get<Target>("target")?.fid !== target.fid ||
        this.get<Target>("target")?.generation !== target.generation
      )
        return;
      if (token) {
        const result = await deliverFcm(
          this.env.FCM_PROJECT,
          token,
          target.fid,
          {
            intent: "connect-v1",
            requestId: wake.requestId,
            expires: String(wake.expires),
            ...(target.generation
              ? { pairingId: pair.id, generation: target.generation }
              : {}),
          },
        );
        delivery = result === "unauthorized" ? "unavailable" : result;
        if (result === "unauthorized")
          await this.env.WAKE_BUDGET?.getByName("global").fetch(
            "https://budget.invalid/invalidate",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ accessToken: token.accessToken }),
            },
          );
      }
      if (
        delivery === "invalid_target" &&
        this.get<Target>("target")?.fid === target.fid &&
        this.get<Target>("target")?.generation === target.generation
      )
        this.drop("target");
    } catch {}
    if (
      this.get<Wake>("wake")?.requestId === wake.requestId &&
      viewer.readyState === WebSocket.OPEN
    )
      viewer.send(JSON.stringify({ type: "contacting", delivery }));
  }
  private async schedule() {
    const deadlines = this.sockets().map(
      (ws) => (ws.deserializeAttachment() as Attachment).deadline,
    );
    const pending = this.get<Pending>("pending"),
      wake = this.get<Wake>("wake");
    if (pending) deadlines.push(pending.expires * 1000);
    if (wake) {
      deadlines.push(wake.expires * 1000);
      if (wake.retryAt) deadlines.push(wake.retryAt);
    }
    if (deadlines.length)
      await this.ctx.storage.setAlarm(
        Math.max(Date.now() + 1, Math.min(...deadlines)),
      );
    else await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    const now = Date.now();
    if ((this.get<Pending>("pending")?.expires ?? Infinity) * 1000 <= now)
      this.drop("pending");
    for (const ws of this.sockets())
      if ((ws.deserializeAttachment() as Attachment).deadline <= now)
        ws.close(4003, "Expired");
    const wake = this.get<Wake>("wake");
    if (
      wake &&
      (wake.expires * 1000 <= now ||
        (wake.retryAt !== undefined && wake.retryAt <= now))
    )
      await this.attemptWake();
    await this.schedule();
  }
}

/** Global wake budget and OAuth token broker. Only Pairing can reach this binding. */
export class WakeBudget extends DurableObject<Env> {
  private auth: FcmAuth;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS budget (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fcm_auth (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)",
    );
    this.auth = new FcmAuth(env.FCM_PROJECT, env.FCM_SERVICE_ACCOUNT, {
      read: () => {
        const row = ctx.storage.sql
          .exec<{ value: string }>("SELECT value FROM fcm_auth WHERE id = 1")
          .toArray()[0];
        return row ? JSON.parse(row.value) : undefined;
      },
      write: (state) => {
        ctx.storage.sql.exec(
          "INSERT INTO fcm_auth VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
          JSON.stringify(state),
        );
      },
    } satisfies TokenStore);
  }
  async fetch(req: Request) {
    const value = await body(req, 20000);
    if (new URL(req.url).pathname === "/invalidate") {
      if (
        typeof value.accessToken !== "string" ||
        value.accessToken.length > 16384
      )
        return json({ error: "Token" }, 400);
      this.auth.invalidate(value.accessToken);
      return json({ invalidated: true });
    }
    const fid = text(value.fid),
      now = Date.now();
    const sql = this.ctx.storage.sql;
    const admitted = this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM budget WHERE until <= ?", now);
      for (const [key, limit] of [
        ["global", 100],
        [`fid:${fid}`, 10],
      ] as const) {
        const row = sql
          .exec<{ count: number }>(
            "SELECT count FROM budget WHERE key = ?",
            key,
          )
          .toArray()[0];
        if ((row?.count ?? 0) >= limit) return false;
      }
      for (const key of ["global", `fid:${fid}`])
        sql.exec(
          "INSERT INTO budget VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count = count + 1",
          key,
          now + 60000,
        );
      return true;
    });
    if (!admitted) return json({ admitted: false }, 429);
    try {
      return json({ token: await this.auth.getToken() });
    } catch {
      return json({ error: "Wake unavailable" }, 503);
    }
  }
}
