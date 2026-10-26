import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import {
  authBytes,
  createBytes,
  fromHex,
  type Grant,
  grantBytes,
  originURL,
  revokeBytes,
  verifySignature,
} from "@remote/protocol/enrollment";
import { WebSocket, WebSocketServer } from "ws";
import { PushRegistry, type Sender, type Wake } from "./push.js";

import { RelayState, type Stored } from "./state.js";

type Pending = {
  id: string;
  viewer: string;
  expires: number;
  offer?: Grant;
  /** The phone's device report, sealed with the QR secret; opaque to the relay. */
  device?: string;
};
/** Close codes a viewer may act on. Sent only after the viewer proves its pinned key. */
export const ACCESS_REMOVED = 4010;
export const ACCESS_PAUSED = 4011;
class Refusal extends Error {
  constructor(readonly code: number) {
    super("Refused");
  }
}
export interface Options {
  origin: string;
  stateDir: string;
  revision?: string;
  trustProxy?: boolean;
  sender?: Sender;
  wakeLifetimeMs?: number;
  wakeCooldownMs?: number;
  wakeBurst?: 1 | 2;
  /** Longest a pairing poll with a `Pair-Wait` header is held for a state change. */
  pairWaitMs?: number;
}
export function createRelay(options: Options) {
  const origin = originURL(options.origin);
  const state = new RelayState(options.stateDir);
  // Preserve shared row identity across async signature checks and revocations.
  const pairs = new Map(Object.entries(state.pairs()));
  let unhealthy = false;
  const durable = (row: Stored) => {
    try {
      if (row.revoked) state.revoke(row);
      else state.putPair(row);
    } catch {
      unhealthy = true;
      for (const ws of wss.clients) ws.terminate();
      throw new Error("Persistence unavailable");
    }
  };
  const push = new PushRegistry(
    state,
    options.sender,
    Date.now,
    options.wakeCooldownMs,
    options.wakeBurst,
  );
  const requests = new Map<string, Wake>();
  const wakeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const clearRequest = (id: string) => {
    requests.delete(id);
    clearTimeout(wakeTimers.get(id));
    wakeTimers.delete(id);
  };
  const pending = new Map<string, Pending>();
  const pairState = (id: string): [number, Record<string, unknown>] => {
    const paired = pairs.get(id);
    if (paired?.revoked) return [410, { error: "Unavailable" }];
    if (paired) return [200, { state: "paired", grant: paired }];
    const p = pending.get(id);
    if (p && p.expires * 1000 > Date.now())
      return [
        200,
        p.offer
          ? { state: "offered", grant: p.offer, device: p.device }
          : { state: "waiting" },
      ];
    return [404, { error: "Unavailable" }];
  };
  // Held pairing polls answer as soon as the other endpoint acts, instead of on the next poll.
  const watchers = new Map<string, Set<() => void>>();
  let watching = 0;
  const changed = (id: string) => {
    const waiting = watchers.get(id);
    watchers.delete(id);
    for (const finish of waiting ?? []) finish();
  };
  const buckets = new Map<
    string,
    { until: number; count: number; enrollments: number }
  >();
  const routes = new Map<
    string,
    Partial<Record<"phone" | "viewer", WebSocket>>
  >();
  const disconnect = (id: string, viewerCode?: number) => {
    const route = routes.get(id);
    routes.delete(id);
    clearRequest(id);
    route?.phone?.close(4001, "Reconnect with a fresh session");
    if (viewerCode === ACCESS_REMOVED)
      route?.viewer?.close(viewerCode, "Access removed");
    else if (viewerCode === ACCESS_PAUSED)
      route?.viewer?.close(viewerCode, "Access paused");
    else route?.viewer?.close(4001, "Reconnect with a fresh session");
  };
  function admit(req: IncomingMessage): boolean {
    if (unhealthy) return false;
    if (req.headers.origin && req.headers.origin !== origin) return false;
    let ip = req.socket.remoteAddress ?? "unknown";
    if (
      options.trustProxy &&
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)
    )
      ip =
        String(req.headers["x-forwarded-for"] ?? ip)
          .split(",")
          .at(-1)
          ?.trim() ?? ip;
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || bucket.until <= now) {
      if (buckets.size >= 10000) return false;
      bucket = { until: now + 60000, count: 0, enrollments: 0 };
      buckets.set(ip, bucket);
    }
    if (
      req.method === "POST" &&
      /^\/api\/pair\/[0-9a-f]{32}$/.test(req.url ?? "")
    ) {
      if (++bucket.enrollments > 10) return false;
    }
    return ++bucket.count <= 240;
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const reply = (status: number, body: unknown) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    try {
      if (req.url === "/health" && req.method === "GET") {
        reply(unhealthy ? 503 : 200, {
          status: unhealthy ? "unavailable" : "ok",
          revision: options.revision ?? "development",
        });
        return;
      }
      if (!admit(req)) {
        reply(429, { error: "Request unavailable" });
        return;
      }
      const parts = req.url?.match(
        /^\/api\/pair\/([0-9a-f]{32})(?:\/(offer|complete|revoke))?$/,
      );
      if (!parts) {
        reply(404, { error: "Not found" });
        return;
      }
      const id = parts[1] ?? "";
      const action = parts[2];
      const existing = pairs.get(id);
      let p = pending.get(id);
      if (p && p.expires * 1000 <= Date.now()) {
        pending.delete(id);
        p = undefined;
      }
      if (req.method === "GET" && !action) {
        const [status, body] = pairState(id);
        const seen = req.headers["pair-wait"];
        if (
          status !== 200 ||
          body.state !== seen ||
          watching >= 1000 ||
          (watchers.get(id)?.size ?? 0) >= 4
        ) {
          reply(status, body);
          return;
        }
        watching++;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          watching--;
          clearTimeout(timer);
          watchers.get(id)?.delete(finish);
          if (!res.destroyed) reply(...pairState(id));
        };
        const timer = setTimeout(finish, options.pairWaitMs ?? 15000);
        const waiting = watchers.get(id) ?? new Set();
        watchers.set(id, waiting.add(finish));
        res.once("close", finish);
        return;
      }
      if (
        req.method !== "POST" ||
        req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
          "application/json"
      ) {
        reply(415, { error: "JSON required" });
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        const b = Buffer.from(chunk);
        length += b.length;
        if (length > 4096) {
          reply(413, { error: "Too large" });
          return;
        }
        chunks.push(b);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      const text = (key: string) => {
        const value = body[key];
        if (typeof value !== "string" || value.length > 512)
          throw new Error("Invalid field");
        return value;
      };
      if (!action) {
        const viewer = text("viewer");
        const expires = body.expires;
        if (
          existing ||
          p ||
          pending.size >= 1000 ||
          pairs.size >= 10000 ||
          !Number.isSafeInteger(expires) ||
          typeof expires !== "number"
        )
          throw new Error("Unavailable");
        if (
          expires * 1000 <= Date.now() ||
          expires * 1000 > Date.now() + 301000
        ) {
          reply(400, { error: "clock-skew", serverTime: Date.now() });
          return;
        }
        await verifySignature(
          viewer,
          createBytes(origin, { id, viewer, expires }),
          text("signature"),
        );
        if (
          pairs.has(id) ||
          pending.has(id) ||
          pending.size >= 1000 ||
          expires * 1000 <= Date.now() ||
          unhealthy
        )
          throw new Error("Unavailable");
        pending.set(id, { id, viewer, expires });
        reply(201, { state: "waiting" });
        changed(id);
      } else if (action === "offer") {
        if (!p || p.offer || existing) throw new Error("Unavailable");
        const grant: Grant = {
          id,
          viewer: p.viewer,
          expires: p.expires,
          phone: text("phone"),
          phoneSignature: text("phoneSignature"),
          mac: text("mac"),
        };
        fromHex(grant.mac, 32);
        const device = body.device;
        if (
          typeof device !== "string" ||
          device.length > 1600 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(device)
        )
          throw new Error("Invalid device report");
        await verifySignature(
          grant.phone,
          grantBytes(origin, grant),
          grant.phoneSignature,
        );
        if (
          pending.get(id) !== p ||
          p.offer ||
          pairs.has(id) ||
          p.expires * 1000 <= Date.now() ||
          unhealthy
        )
          throw new Error("Unavailable");
        p.offer = grant;
        p.device = device;
        reply(202, { state: "offered" });
        changed(id);
      } else if (action === "complete") {
        if (!p?.offer || existing) throw new Error("Unavailable");
        const viewerSignature = text("viewerSignature");
        await verifySignature(
          p.viewer,
          grantBytes(origin, p.offer),
          viewerSignature,
        );
        if (
          pending.get(id) !== p ||
          pairs.has(id) ||
          p.expires * 1000 <= Date.now() ||
          unhealthy
        )
          throw new Error("Unavailable");
        // Recheck after verification: no await between admission and durable insert.
        if (!state.canEnroll()) {
          res.setHeader("Retry-After", "3600");
          reply(429, { error: "Enrollment temporarily unavailable" });
          return;
        }
        const pair = { ...p.offer, viewerSignature, revoked: false };
        pairs.set(id, pair);
        durable(pair);
        pending.delete(id);
        reply(200, { state: "paired", grant: pair });
        changed(id);
      } else if (action === "revoke") {
        if (!existing) throw new Error("Unavailable");
        await verifySignature(
          existing.phone,
          revokeBytes(origin, id),
          text("signature"),
        );
        if (unhealthy) throw new Error("Unavailable");
        existing.revoked = true;
        durable(existing);
        disconnect(id, ACCESS_REMOVED);
        push.remove(id);
        reply(200, { state: "revoked" });
        changed(id);
      }
    } catch {
      if (!res.headersSent)
        reply(unhealthy ? 503 : 400, { error: "Request rejected" });
      else res.end();
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  server.maxHeadersCount = 32;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1048608,
    perMessageDeflate: false,
  });
  const unauthenticated = new Set<WebSocket>();
  const managers = new Map<string, WebSocket>();
  server.on("upgrade", (req, socket, head) => {
    if (
      !/^\/api\/socket(?:\?id=[0-9a-f]{32})?$/.test(req.url ?? "") ||
      !admit(req) ||
      wss.clients.size >= 1000 ||
      unauthenticated.size >= 64
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  });
  wss.on("connection", (ws: WebSocket, req) => {
    const routeId = new URL(req.url ?? "/", origin).searchParams.get("id");
    unauthenticated.add(ws);
    const nonce = randomBytes(32).toString("hex");
    ws.send(JSON.stringify({ type: "challenge", nonce }));
    let id: string | undefined;
    let role: "phone" | "viewer" | undefined;
    let working = false;
    let authenticated = false;
    let pushUpdated = false;
    let policyUpdated = false;
    let managementOnly = false;
    let alive = true;
    const timeout = setTimeout(
      () => ws.close(4003, "Authentication expired"),
      10000,
    );
    const lifetime = setTimeout(
      () => ws.close(4001, "Session expired"),
      3600000,
    );
    const heartbeat = setInterval(() => {
      if (!alive) ws.terminate();
      else {
        alive = false;
        ws.ping();
      }
    }, 30000);
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      unauthenticated.delete(ws);
      if (id && managers.get(id) === ws) managers.delete(id);
      clearTimeout(timeout);
      clearTimeout(lifetime);
      clearInterval(heartbeat);
      if (id && role && routes.get(id)?.[role] === ws) disconnect(id);
    });
    ws.on("message", async (input, binary) => {
      const data = Buffer.isBuffer(input)
        ? input
        : Array.isArray(input)
          ? Buffer.concat(input)
          : Buffer.from(input);
      try {
        if (unhealthy) throw new Error("Unavailable");
        if (!authenticated) {
          if (binary || working || data.length > 2048)
            throw new Error("Authentication required");
          working = true;
          const message = JSON.parse(data.toString()) as {
            id: string;
            role: string;
            signature: string;
            requestId?: string;
            mode?: string;
            generation?: string;
          };
          fromHex(message.id, 16);
          if (routeId !== null && routeId !== message.id)
            throw new Error("Routing ID mismatch");
          if (message.role !== "phone" && message.role !== "viewer")
            throw new Error("Invalid role");
          const pair = pairs.get(message.id);
          if (!pair) throw new Error("Unavailable");
          // Tombstones keep both keys, so only the paired viewer learns why it is refused.
          await verifySignature(
            pair[message.role],
            authBytes(origin, message.id, message.role, nonce),
            message.signature,
          );
          if (pair.revoked && message.role === "viewer")
            throw new Refusal(ACCESS_REMOVED);
          if (pair.revoked || ws.readyState !== WebSocket.OPEN || unhealthy)
            throw new Error("Unavailable");
          if (message.mode !== undefined) {
            if (
              message.role !== "phone" ||
              message.mode !== "registration" ||
              message.requestId !== undefined
            )
              throw new Error("Invalid mode");
            if (managers.has(message.id)) throw new Error("Already managing");
            managers.set(message.id, ws);
            id = message.id;
            role = "phone";
            managementOnly = true;
            authenticated = true;
            unauthenticated.delete(ws);
            clearTimeout(timeout);
            ws.send(JSON.stringify({ type: "authenticated" }));
            return;
          }
          if (pair.accessEnabled === false && message.role === "viewer")
            throw new Refusal(ACCESS_PAUSED);
          if (
            pair.accessEnabled === false ||
            (message.role === "phone" &&
              pair.accessGeneration !== undefined &&
              message.generation !== pair.accessGeneration)
          )
            throw new Error("Access disabled or superseded");
          const route = routes.get(message.id) ?? {};
          if (message.requestId !== undefined) {
            const pendingRequest = requests.get(message.id);
            if (
              message.role !== "phone" ||
              !route.viewer ||
              !pendingRequest ||
              pendingRequest.requestId !== message.requestId ||
              pendingRequest.expires * 1000 <= Date.now()
            )
              throw new Error("No current request");
          }
          if (route[message.role]) throw new Error("Already connected");
          id = message.id;
          role = message.role;
          route[role] = ws;
          routes.set(id, route);
          authenticated = true;
          unauthenticated.delete(ws);
          clearTimeout(timeout);
          ws.send(JSON.stringify({ type: "authenticated" }));
          if (options.sender && role === "viewer" && !route.phone) {
            const request = {
              requestId: randomBytes(16).toString("hex"),
              expires: Math.floor(
                (Date.now() + (options.wakeLifetimeMs ?? 60000)) / 1000,
              ),
            };
            requests.set(id, request);
            const pairingId = id;
            const stillWaiting = () =>
              ws.readyState === WebSocket.OPEN &&
              requests.get(pairingId) === request &&
              routes.get(pairingId)?.viewer === ws &&
              !routes.get(pairingId)?.phone;
            const sendWake = async () => {
              wakeTimers.delete(pairingId);
              if (!stillWaiting()) return;
              if (request.expires * 1000 <= Date.now()) {
                disconnect(pairingId);
                return;
              }
              try {
                const delivery = await push.wake(pairingId, request);
                if (!stillWaiting()) return;
                ws.send(JSON.stringify({ type: "contacting", delivery }));
                // A new viewer has a fresh request ID. An earlier wake cannot
                // satisfy it: retain the rate limit, then send this exact request.
                if (delivery === "coalesced") {
                  const delay = Math.min(
                    Math.max(1, push.retryAfterMs(pairingId)),
                    request.expires * 1000 - Date.now(),
                  );
                  wakeTimers.set(
                    pairingId,
                    setTimeout(() => void sendWake(), delay),
                  );
                }
              } catch {
                if (stillWaiting()) ws.close(4003, "Wake unavailable");
              }
            };
            void sendWake();
          }
          if (route.phone && route.viewer) {
            clearRequest(id);
            for (const peer of Object.values(route))
              peer.send(JSON.stringify({ type: "ready" }));
          }
        } else {
          if (managementOnly && binary) throw new Error("Registration only");
          const pair = id ? pairs.get(id) : undefined;
          const route = id ? routes.get(id) : undefined;
          const peer = role === "phone" ? route?.viewer : route?.phone;
          if (
            !binary &&
            role === "phone" &&
            pair &&
            !pair.revoked &&
            data.length <= 512
          ) {
            const registration = JSON.parse(data.toString()) as {
              type: string;
              fid: string;
              enabled?: boolean;
              generation?: string;
            };
            if (registration.type === "setAccess") {
              if (
                !managementOnly ||
                policyUpdated ||
                typeof registration.enabled !== "boolean" ||
                typeof registration.generation !== "string"
              )
                throw new Error("Invalid policy");
              fromHex(registration.generation, 16);
              if (
                pair.accessGeneration !== registration.generation ||
                pair.accessEnabled !== registration.enabled
              ) {
                // A new pairing's first enabled policy changes nothing for routes
                // already open, such as the browser's check right after pairing.
                const first = pair.accessGeneration === undefined;
                pair.accessGeneration = registration.generation;
                pair.accessEnabled = registration.enabled;
                durable(pair);
                if (!first || !registration.enabled) {
                  disconnect(
                    pair.id,
                    registration.enabled ? undefined : ACCESS_PAUSED,
                  );
                  push.remove(pair.id);
                }
              }
              policyUpdated = true;
              ws.send(JSON.stringify({ type: "accessUpdated" }));
              return;
            }
            if (pushUpdated) throw new Error("Metadata already set");
            if (registration.type === "registerPush")
              push.register(pair.id, registration.fid, pair.accessGeneration);
            else if (registration.type === "unregisterPush")
              push.remove(pair.id);
            else throw new Error("Invalid metadata");
            pushUpdated = true;
            ws.send(
              JSON.stringify({
                type:
                  registration.type === "registerPush"
                    ? "pushRegistered"
                    : "pushRemoved",
              }),
            );
            return;
          }
          if (
            !binary ||
            !pair ||
            pair.revoked ||
            !peer ||
            peer.readyState !== WebSocket.OPEN ||
            peer.bufferedAmount > 1048608
          )
            throw new Error("Peer unavailable");
          peer.send(data, { binary: true });
        }
      } catch (error) {
        if (error instanceof Refusal)
          ws.close(
            error.code,
            error.code === ACCESS_REMOVED ? "Access removed" : "Access paused",
          );
        else ws.close(4003, "Request rejected");
      }
    });
  });
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, p] of pending)
      if (p.expires * 1000 <= now) pending.delete(id);
    for (const [id, request] of requests)
      if (request.expires * 1000 <= now) disconnect(id);
    for (const [ip, b] of buckets) if (b.until <= now) buckets.delete(ip);
  }, 10000);
  sweep.unref();
  return {
    server,
    async close() {
      clearInterval(sweep);
      for (const id of [...watchers.keys()]) changed(id);
      for (const id of requests.keys()) clearRequest(id);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      state.close();
    },
  };
}
