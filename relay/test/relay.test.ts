import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  b64,
  createIdentity,
  type Identity,
  PhoneHandshake,
  utf8,
  ViewerHandshake,
} from "@remote/protocol";
import {
  authBytes,
  createBytes,
  decodeInvitation,
  encodeInvitation,
  fromHex,
  type Grant,
  grantBytes,
  grantMac,
  hex,
  type Invitation,
  revokeBytes,
  verifyOffer,
} from "@remote/protocol/enrollment";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { Options } from "../src/server.js";
import { createRelay } from "../src/server.js";

import { RelayState } from "../src/state.js";

function pushState() {
  const state = new RelayState(directory);
  try {
    return JSON.stringify(state.targets());
  } finally {
    state.close();
  }
}

const origin = "https://example.test";
let directory: string;
let relay: ReturnType<typeof createRelay>;
let base: string;
let viewer: Identity;
let phone: Identity;
let invitation: Invitation;
const sockets: WebSocket[] = [];
async function start(config: Partial<Options> = {}) {
  relay = createRelay({ origin, stateDir: directory, ...config });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const address = relay.server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  base = `http://127.0.0.1:${address.port}`;
}
const api = (
  suffix = "",
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  // Offers carry the phone's sealed device report, which the relay passes on opaquely.
  if (suffix === "/offer" && body && typeof body === "object")
    body = { device: "c2VhbGVkIGRldmljZQ==", ...body };
  return fetch(
    `${base}/api/pair/${invitation.id}${suffix}`,
    body === undefined
      ? { headers }
      : {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        },
  );
};
async function create() {
  return api("", {
    viewer: invitation.viewer,
    expires: invitation.expires,
    signature: b64(await viewer.sign(createBytes(origin, invitation))),
  });
}
async function offer(): Promise<Grant> {
  const g: Grant = {
    id: invitation.id,
    viewer: invitation.viewer,
    phone: b64(phone.publicKey),
    expires: invitation.expires,
    mac: "",
    phoneSignature: "",
  };
  g.mac = hex(await grantMac(invitation.secret, grantBytes(origin, g)));
  g.phoneSignature = b64(await phone.sign(grantBytes(origin, g)));
  return g;
}
async function enroll() {
  expect((await create()).status).toBe(201);
  const g = await offer();
  expect((await api("/offer", g)).status).toBe(202);
  await verifyOffer(invitation, g);
  expect(
    (
      await api("/complete", {
        viewerSignature: b64(await viewer.sign(grantBytes(origin, g))),
      })
    ).status,
  ).toBe(200);
  return g;
}
function client(headers: Record<string, string> = {}, route = "") {
  const socket = new WebSocket(
    `${base.replace("http:", "ws:")}/api/socket${route}`,
    {
      headers,
    },
  );
  sockets.push(socket);
  const queue: { data: Buffer; binary: boolean }[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  socket.on("error", () => {});
  socket.on("message", (data, binary) => {
    queue.push({ data: Buffer.from(data as Buffer), binary });
    wake?.();
  });
  socket.on("close", () => {
    closed = true;
    wake?.();
  });
  async function next() {
    const deadline = Date.now() + 2000;
    while (!queue.length && !closed && Date.now() < deadline)
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(1, deadline - Date.now()));
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    const value = queue.shift();
    if (!value) throw new Error("Closed or timed out");
    return value;
  }
  const json = async () =>
    JSON.parse((await next()).data.toString()) as {
      type: string;
      nonce: string;
      delivery?: string;
    };
  return {
    socket,
    next,
    json,
    async login(
      identity: Identity,
      role: string,
      metadata: Record<string, unknown> = {},
    ) {
      const c = await json();
      socket.send(
        JSON.stringify({
          ...metadata,
          id: invitation.id,
          role,
          signature: b64(
            await identity.sign(
              authBytes(origin, invitation.id, role, c.nonce),
            ),
          ),
        }),
      );
      return json();
    },
  };
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "remote-relay-test-"));
  await start();
  viewer = await createIdentity();
  phone = await createIdentity();
  invitation = {
    v: 1,
    origin,
    id: hex(crypto.getRandomValues(new Uint8Array(16))),
    viewer: b64(viewer.publicKey),
    expires: Math.floor(Date.now() / 1000) + 120,
    secret: hex(crypto.getRandomValues(new Uint8Array(32))),
    name: "Test browser",
  };
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await relay.close();
  await rm(directory, { recursive: true, force: true });
});
it("routes standard client URLs but binds authentication to that same pairing", async () => {
  await enroll();
  const viewerClient = client({}, `?id=${invitation.id}`);
  expect((await viewerClient.login(viewer, "viewer")).type).toBe(
    "authenticated",
  );
  const wrongRoute = client({}, `?id=${"ff".repeat(16)}`);
  const closed = once(wrongRoute.socket, "close");
  await expect(wrongRoute.login(phone, "phone")).rejects.toThrow("Closed");
  expect((await closed)[0]).toBe(4003);
  // Existing installed clients still use the bare route.
  const phoneClient = client();
  expect((await phoneClient.login(phone, "phone")).type).toBe("authenticated");
  expect((await viewerClient.json()).type).toBe("ready");
});

it.each([
  "?id=bad",
  "?other=value",
  `?id=${"ab".repeat(16)}&id=${"cd".repeat(16)}`,
])("refuses malformed socket routing %s before upgrading", async (route) => {
  const socket = client({}, route);
  await expect(socket.json()).rejects.toThrow("Closed");
});

it("rejects malformed absolute upgrade targets without parsing an untrusted URL", async () => {
  const target = new URL(base);
  const socket = createConnection({
    host: target.hostname,
    port: Number(target.port),
  });
  try {
    await once(socket, "connect");
    const closed = once(socket, "close");
    socket.write(
      "GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
    await closed;
    expect((await fetch(`${base}/health`)).status).toBe(200);
  } finally {
    socket.destroy();
  }
});

it("pairs only after both endpoint signatures and never stores the QR secret", async () => {
  await enroll();
  const state = new RelayState(directory);
  const stored = JSON.stringify(state.pairs());
  state.close();
  expect(stored).not.toContain(invitation.secret);
  expect((await create()).status).toBe(400);
  expect((await api()).status).toBe(200);
});
it.each([
  3000, -600000,
])("returns the service clock before allocating a skewed request (%d ms)", async (offset) => {
  invitation.expires = Math.floor((Date.now() + offset) / 1000) + 300;
  const rejected = await create();
  expect(rejected.status).toBe(400);
  const detail = (await rejected.json()) as {
    error: string;
    serverTime: number;
  };
  expect(detail.error).toBe("clock-skew");
  expect(Math.abs(detail.serverTime - Date.now())).toBeLessThan(5000);
  expect((await api()).status).toBe(404);
  invitation.expires = Math.floor(detail.serverTime / 1000) + 300;
  expect((await create()).status).toBe(201);
  expect((await api()).status).toBe(200);
});
it("answers held pairing polls when the other endpoint acts", async () => {
  expect((await create()).status).toBe(201);
  const started = Date.now();
  const browserWait = api("", undefined, { "Pair-Wait": "waiting" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const g = await offer();
  expect((await api("/offer", g)).status).toBe(202);
  const offered = await browserWait;
  expect(await offered.json()).toMatchObject({
    state: "offered",
    device: "c2VhbGVkIGRldmljZQ==",
  });
  const phoneWait = api("", undefined, { "Pair-Wait": "offered" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const viewerSignature = b64(await viewer.sign(grantBytes(origin, g)));
  expect((await api("/complete", { viewerSignature })).status).toBe(200);
  expect(await (await phoneWait).json()).toMatchObject({ state: "paired" });
  expect(Date.now() - started).toBeLessThan(2000);
  // Without the header, or with a different seen state, polls answer at once.
  expect(await (await api()).json()).toMatchObject({ state: "paired" });
  expect(
    await (await api("", undefined, { "Pair-Wait": "offered" })).json(),
  ).toMatchObject({ state: "paired" });
});
it("returns the unchanged pairing state when a held poll times out", async () => {
  await relay.close();
  await start({ pairWaitMs: 400 });
  expect((await create()).status).toBe(201);
  const started = Date.now();
  const reply = await api("", undefined, { "Pair-Wait": "waiting" });
  // Timers can fire a little early against a busy loop's cached clock.
  expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  expect(await reply.json()).toEqual({ state: "waiting" });
});
it("rejects wrong QR secrets, substituted phone keys and expired invitations at endpoints", async () => {
  const g = await offer();
  await expect(
    verifyOffer({ ...invitation, secret: "00".repeat(32) }, g),
  ).rejects.toThrow();
  await expect(
    verifyOffer(invitation, { ...g, phone: b64(viewer.publicKey) }),
  ).rejects.toThrow();
  expect(decodeInvitation(encodeInvitation(invitation))).toEqual(invitation);
  expect(() =>
    decodeInvitation(encodeInvitation({ ...invitation, expires: 1 })),
  ).toThrow();
});
it("rejects invalid signatures, expired creation and unconfirmed routes", async () => {
  expect(
    (
      await api("", {
        viewer: invitation.viewer,
        expires: invitation.expires,
        signature: b64(await phone.sign(createBytes(origin, invitation))),
      })
    ).status,
  ).toBe(400);
  invitation.expires = 1;
  expect((await create()).status).toBe(400);
  const c = client();
  await expect(c.login(viewer, "viewer")).rejects.toThrow();
});
it("cannot replace a pending offer or complete with another viewer", async () => {
  await create();
  const g = await offer();
  expect((await api("/offer", g)).status).toBe(202);
  expect((await api("/offer", g)).status).toBe(400);
  expect(
    (
      await api("/complete", {
        viewerSignature: b64(await phone.sign(grantBytes(origin, g))),
      })
    ).status,
  ).toBe(400);
  expect((await api()).status).toBe(200);
});
it("forwards a real authenticated E2E handshake and binary Unicode record", async () => {
  await enroll();
  const v = client();
  const p = client();
  expect((await v.login(viewer, "viewer")).type).toBe("authenticated");
  expect((await p.login(phone, "phone")).type).toBe("authenticated");
  expect((await v.json()).type).toBe("ready");
  expect((await p.json()).type).toBe("ready");
  const va = {
    id: fromHex(invitation.id, 16),
    generation: 1,
    peer: phone.publicKey,
    current: () => true,
  };
  const vh = await ViewerHandshake.start(viewer, va);
  v.socket.send(vh.hello);
  const ph = await PhoneHandshake.start(
    phone,
    { ...va, peer: viewer.publicKey },
    new Uint8Array((await p.next()).data),
  );

  p.socket.send(ph.offer);
  v.socket.send(await vh.answer(new Uint8Array((await v.next()).data)));
  const accepted = await ph.finish(new Uint8Array((await p.next()).data));
  p.socket.send(accepted.finish);
  const channel = await vh.finish(new Uint8Array((await v.next()).data));
  const message = utf8("hello 🌞\0");
  const record = await channel.seal(message);
  expect(Buffer.from(record).includes(Buffer.from(message))).toBe(false);
  v.socket.send(record);
  expect(
    await accepted.channel.open(new Uint8Array((await p.next()).data)),
  ).toEqual(message);
  channel.close();
  accepted.channel.close();
});
it("rejects wrong-role authentication and replay on another challenge", async () => {
  await enroll();
  const bad = client();
  await expect(bad.login(viewer, "phone")).rejects.toThrow();
  const a = client();
  const challenge = await a.json();
  const signature = b64(
    await viewer.sign(
      authBytes(origin, invitation.id, "viewer", challenge.nonce),
    ),
  );
  const b = client();
  await b.json();
  b.socket.send(
    JSON.stringify({ id: invitation.id, role: "viewer", signature }),
  );
  await expect(b.next()).rejects.toThrow();
});
it("rejects cross-origin browser sockets and API mutations", async () => {
  expect((await create()).status).toBe(201);
  expect(
    (await api("/offer", await offer(), { Origin: "https://evil.test" }))
      .status,
  ).toBe(429);
  const c = client({ Origin: "https://evil.test" });
  await expect(c.next()).rejects.toThrow();
});
it("persists authority across restart and retains revoked tombstones", async () => {
  await enroll();
  await relay.close();
  await start();
  const c = client();
  expect((await c.login(phone, "phone")).type).toBe("authenticated");
  const closed = once(c.socket, "close");
  expect(
    (
      await api("/revoke", {
        signature: b64(await phone.sign(revokeBytes(origin, invitation.id))),
      })
    ).status,
  ).toBe(200);
  await closed;
  await relay.close();
  await start();
  expect((await api()).status).toBe(410);
  expect((await create()).status).toBe(400);
  const rejected = client();
  await expect(rejected.login(phone, "phone")).rejects.toThrow();
});
it("tells only the paired viewer that access was removed", async () => {
  await enroll();
  const live = client();
  expect((await live.login(viewer, "viewer")).type).toBe("authenticated");
  const ended = once(live.socket, "close");
  expect(
    (
      await api("/revoke", {
        signature: b64(await phone.sign(revokeBytes(origin, invitation.id))),
      })
    ).status,
  ).toBe(200);
  expect((await ended)[0]).toBe(4010);
  const later = client();
  const refused = once(later.socket, "close");
  await expect(later.login(viewer, "viewer")).rejects.toThrow();
  expect((await refused)[0]).toBe(4010);
  const stranger = client();
  const rejected = once(stranger.socket, "close");
  await expect(
    stranger.login(await createIdentity(), "viewer"),
  ).rejects.toThrow();
  expect((await rejected)[0]).toBe(4003);
});
it("refuses viewer revocation and duplicate sockets without displacing the original", async () => {
  await enroll();
  expect(
    (
      await api("/revoke", {
        signature: b64(await viewer.sign(revokeBytes(origin, invitation.id))),
      })
    ).status,
  ).toBe(400);
  const a = client();
  await a.login(viewer, "viewer");
  const b = client();
  await expect(b.login(viewer, "viewer")).rejects.toThrow();
  expect(a.socket.readyState).toBe(WebSocket.OPEN);
});
it("closes both peers on transport loss; never queues disconnected records", async () => {
  await enroll();
  const a = client();
  const b = client();
  await a.login(viewer, "viewer");
  await b.login(phone, "phone");
  await a.json();
  await b.json();
  const closed = once(b.socket, "close");
  a.socket.close();
  await closed;
  const alone = client();
  await alone.login(viewer, "viewer");
  alone.socket.send(Buffer.from("not queued"));
  await expect(alone.next()).rejects.toThrow();
});
it("bounds bodies and rejects plaintext application traffic", async () => {
  expect((await api("", { oversized: "x".repeat(5000) })).status).toBe(413);
  await enroll();
  const a = client();
  const b = client();
  await a.login(viewer, "viewer");
  await b.login(phone, "phone");
  await a.json();
  await b.json();
  a.socket.send("plaintext");
  await expect(a.next()).rejects.toThrow();
});

it("accepts native JSON media types with UTF-8 charset parameters", async () => {
  const response = await api(
    "",
    {
      viewer: invitation.viewer,
      expires: invitation.expires,
      signature: b64(await viewer.sign(createBytes(origin, invitation))),
    },
    { "Content-Type": "application/json; charset=utf-8" },
  );
  expect(response.status).toBe(201);
});

const fid = `c${"a".repeat(21)}`;
async function registerPush() {
  const registration = client();
  await registration.login(phone, "phone", { mode: "registration" });
  registration.socket.send(JSON.stringify({ type: "registerPush", fid }));
  expect((await registration.json()).type).toBe("pushRegistered");
  const closed = once(registration.socket, "close");
  registration.socket.close();
  await closed;
}
it("wakes only for an authenticated viewer and hides registration metadata", async () => {
  let sent: { requestId: string; expires: number } | undefined;
  await relay.close();
  await start({
    sender: async (_fid, request) => {
      sent = request;
      return "accepted";
    },
  });
  await enroll();
  await registerPush();
  expect(JSON.stringify(await (await api()).json())).not.toContain(fid);
  const bad = client();
  await expect(bad.login(phone, "viewer")).rejects.toThrow();
  expect(sent).toBeUndefined();
  const v = client();
  await v.login(viewer, "viewer");
  expect((await v.json()).type).toBe("contacting");
  expect(sent).toBeDefined();
  const p = client();
  await p.login(phone, "phone", { requestId: sent?.requestId });
  expect((await p.json()).type).toBe("ready");
  expect((await v.json()).type).toBe("ready");
});
it("registration refresh does not displace a live encrypted route", async () => {
  await enroll();
  const v = client();
  const p = client();
  await v.login(viewer, "viewer");
  await p.login(phone, "phone");
  await v.json();
  await p.json();
  await registerPush();
  expect(v.socket.readyState).toBe(WebSocket.OPEN);
  expect(p.socket.readyState).toBe(WebSocket.OPEN);
});
it("admits two immediate authenticated wakes, then queues the next fresh request", async () => {
  const sent: string[] = [];
  await relay.close();
  await start({
    wakeCooldownMs: 1000,
    sender: async (_fid, wake) => {
      sent.push(wake.requestId);
      return "accepted";
    },
  });
  await enroll();
  await registerPush();
  for (let count = 0; count < 2; count++) {
    const viewerSocket = client();
    await viewerSocket.login(viewer, "viewer");
    expect(await viewerSocket.json()).toMatchObject({ delivery: "accepted" });
    const closed = once(viewerSocket.socket, "close");
    viewerSocket.socket.close();
    await closed;
  }
  expect(new Set(sent).size).toBe(2);
  const third = client();
  await third.login(viewer, "viewer");
  expect(await third.json()).toMatchObject({ delivery: "coalesced" });
  expect(sent).toHaveLength(2);
  // A timer may run just before fractional refill completes and report its
  // continued wait again. Require eventual delivery without assuming that
  // Node's real timers produce exactly one intermediate status.
  let result = await third.json();
  while (result.delivery === "coalesced") {
    expect(result).toMatchObject({ type: "contacting" });
    result = await third.json();
  }
  expect(result).toMatchObject({ delivery: "accepted" });
  expect(new Set(sent).size).toBe(3);
});

it("delivers a fresh wake after a rapid check-to-control reconnect", async () => {
  const sent: { requestId: string; expires: number }[] = [];
  await relay.close();
  await start({
    wakeCooldownMs: 400,
    wakeBurst: 1,
    sender: async (_fid, request) => {
      sent.push(request);
      return "accepted";
    },
  });
  await enroll();
  await registerPush();
  const check = client();
  await check.login(viewer, "viewer");
  await check.json();
  const firstPhone = client();
  await firstPhone.login(phone, "phone", { requestId: sent[0]?.requestId });
  await firstPhone.json();
  await check.json();
  const ended = once(firstPhone.socket, "close");
  check.socket.close();
  await ended;

  const control = client();
  await control.login(viewer, "viewer");
  expect(await control.json()).toMatchObject({
    type: "contacting",
    delivery: "coalesced",
  });
  expect(sent).toHaveLength(1);
  // The old hint must never authorize this new request while a resend is queued.
  const stale = client();
  await expect(
    stale.login(phone, "phone", { requestId: sent[0]?.requestId }),
  ).rejects.toThrow();
  // Refusing the stale phone can report the still-coalesced request again.
  // Consume progress until delivery; arrival order depends on the event loop.
  let progress = await control.json();
  for (
    let update = 0;
    progress.delivery === "coalesced" && update < 4;
    update++
  ) {
    expect(progress.type).toBe("contacting");
    progress = await control.json();
  }
  expect(progress).toMatchObject({
    type: "contacting",
    delivery: "accepted",
  });
  expect(sent).toHaveLength(2);
  expect(sent[1]?.requestId).not.toBe(sent[0]?.requestId);
  const nextPhone = client();
  await nextPhone.login(phone, "phone", { requestId: sent[1]?.requestId });
  expect((await nextPhone.json()).type).toBe("ready");
  expect((await control.json()).type).toBe("ready");
});

it.each([
  "viewer leaves",
  "access revoked",
  "phone arrives",
])("cancels a delayed wake when %s", async (reason) => {
  const sent: unknown[] = [];
  await relay.close();
  await start({
    wakeCooldownMs: 300,
    wakeBurst: 1,
    sender: async (_fid, request) => {
      sent.push(request);
      return "accepted";
    },
  });
  await enroll();
  await registerPush();
  const first = client();
  await first.login(viewer, "viewer");
  await first.json();
  const ended = once(first.socket, "close");
  first.socket.close();
  await ended;
  const waiting = client();
  await waiting.login(viewer, "viewer");
  expect(await waiting.json()).toMatchObject({ delivery: "coalesced" });
  if (reason === "viewer leaves") {
    const closed = once(waiting.socket, "close");
    waiting.socket.close();
    await closed;
  } else if (reason === "access revoked") {
    expect(
      (
        await api("/revoke", {
          signature: b64(await phone.sign(revokeBytes(origin, invitation.id))),
        })
      ).status,
    ).toBe(200);
  } else {
    const arriving = client();
    await arriving.login(phone, "phone");
    expect((await arriving.json()).type).toBe("ready");
    expect((await waiting.json()).type).toBe("ready");
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(sent).toHaveLength(1);
});
it("expires a queued wake rather than sending a stale hint", async () => {
  let sends = 0;
  await relay.close();
  await start({
    wakeCooldownMs: 2500,
    wakeBurst: 1,
    wakeLifetimeMs: 1200,
    sender: async () => {
      sends++;
      return "accepted";
    },
  });
  await enroll();
  await registerPush();
  const first = client();
  await first.login(viewer, "viewer");
  await first.json();
  const ended = once(first.socket, "close");
  first.socket.close();
  await ended;
  const waiting = client();
  await waiting.login(viewer, "viewer");
  expect(await waiting.json()).toMatchObject({ delivery: "coalesced" });
  await once(waiting.socket, "close");
  expect(sends).toBe(1);
});
it("rejects delayed, expired and revoked wake requests", async () => {
  let sent: { requestId: string; expires: number } | undefined;
  await relay.close();
  await start({
    sender: async (_fid, request) => {
      sent = request;
      return "accepted";
    },
    wakeLifetimeMs: 1000,
  });
  await enroll();
  await registerPush();
  const v = client();
  await v.login(viewer, "viewer");
  await v.json();
  const wrong = client();
  await expect(
    wrong.login(phone, "phone", { requestId: "00".repeat(16) }),
  ).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const expired = client();
  await expect(
    expired.login(phone, "phone", { requestId: sent?.requestId }),
  ).rejects.toThrow();
  await api("/revoke", {
    signature: b64(await phone.sign(revokeBytes(origin, invitation.id))),
  });
  const revoked = client();
  await expect(
    revoked.login(phone, "phone", { requestId: sent?.requestId }),
  ).rejects.toThrow();
  expect(pushState()).not.toContain(fid);
});

it("lets the phone disable delivery but refuses viewer registration", async () => {
  await enroll();
  await registerPush();
  const v = client();
  await v.login(viewer, "viewer");
  v.socket.send(JSON.stringify({ type: "registerPush", fid }));
  await expect(v.next()).rejects.toThrow();
  const p = client();
  await p.login(phone, "phone", { mode: "registration" });
  p.socket.send(JSON.stringify({ type: "unregisterPush" }));
  expect((await p.json()).type).toBe("pushRemoved");
  expect(pushState()).not.toContain(fid);
});
it("registration-only connections cannot inject records into a live route", async () => {
  await enroll();
  const v = client();
  const p = client();
  const management = client();
  await v.login(viewer, "viewer");
  await p.login(phone, "phone");
  await v.json();
  await p.json();
  await management.login(phone, "phone", { mode: "registration" });
  management.socket.send(Buffer.from("invalid management record"));
  await expect(management.next()).rejects.toThrow();
  expect(v.socket.readyState).toBe(WebSocket.OPEN);
  expect(p.socket.readyState).toBe(WebSocket.OPEN);
});

async function setAccess(enabled: boolean, generation: string) {
  const manager = client();
  await manager.login(phone, "phone", { mode: "registration" });
  manager.socket.send(
    JSON.stringify({ type: "setAccess", enabled, generation }),
  );
  expect((await manager.json()).type).toBe("accessUpdated");
  manager.socket.close();
}
it("keeps the first check open when a new pairing publishes its first policy", async () => {
  await enroll();
  const v = client();
  expect((await v.login(viewer, "viewer")).type).toBe("authenticated");
  let closed = false;
  v.socket.on("close", () => {
    closed = true;
  });
  await setAccess(true, "11".repeat(16));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(closed).toBe(false);
  const ended = once(v.socket, "close");
  await setAccess(true, "22".repeat(16));
  expect((await ended)[0]).toBe(4001);
});
it("phone policy cancels pending sessions, persists pause and rejects old generations after re-enable", async () => {
  await enroll();
  const v = client();
  await v.login(viewer, "viewer");
  const closed = once(v.socket, "close");
  await setAccess(false, "11".repeat(16));
  expect((await closed)[0]).toBe(4011);
  const disabled = client();
  const paused = once(disabled.socket, "close");
  await expect(disabled.login(viewer, "viewer")).rejects.toThrow();
  expect((await paused)[0]).toBe(4011);
  await relay.close();
  await start();
  const persisted = client();
  await expect(persisted.login(phone, "phone")).rejects.toThrow();
  await setAccess(true, "22".repeat(16));
  const stale = client();
  await expect(
    stale.login(phone, "phone", { generation: "11".repeat(16) }),
  ).rejects.toThrow();
  const current = client();
  expect(
    (await current.login(phone, "phone", { generation: "22".repeat(16) })).type,
  ).toBe("authenticated");
});
it("viewers cannot change phone policy", async () => {
  await enroll();
  const v = client();
  await v.login(viewer, "viewer");
  v.socket.send(
    JSON.stringify({
      type: "setAccess",
      enabled: false,
      generation: "11".repeat(16),
    }),
  );
  await expect(v.next()).rejects.toThrow();
  const p = client();
  expect((await p.login(phone, "phone")).type).toBe("authenticated");
});
it("push hints select the exact browser generation without carrying authority", async () => {
  let sent: import("../src/push.js").Wake | undefined;
  await relay.close();
  await start({
    sender: async (_target, hint) => {
      sent = hint;
      return "accepted";
    },
  });
  await enroll();
  const generation = "33".repeat(16);
  await setAccess(true, generation);
  await registerPush();
  const v = client();
  await v.login(viewer, "viewer");
  await v.json();
  expect(sent?.pairingId).toBe(invitation.id);
  expect(sent?.generation).toBe(generation);
});

it("independently enrolls and revokes two browsers for the same phone", async () => {
  await enroll();
  const first = invitation;
  const firstViewer = viewer;
  viewer = await createIdentity();
  invitation = {
    ...first,
    id: hex(crypto.getRandomValues(new Uint8Array(16))),
    viewer: b64(viewer.publicKey),
    secret: hex(crypto.getRandomValues(new Uint8Array(32))),
  };
  await enroll();
  const second = invitation;
  const secondViewer = viewer;
  invitation = first;
  viewer = firstViewer;
  await setAccess(false, "11".repeat(16));
  const denied = client();
  await expect(denied.login(firstViewer, "viewer")).rejects.toThrow();
  await api("/revoke", {
    signature: b64(await phone.sign(revokeBytes(origin, first.id))),
  });
  invitation = second;
  viewer = secondViewer;
  expect((await api()).status).toBe(200);
  const unaffected = client();
  expect((await unaffected.login(secondViewer, "viewer")).type).toBe(
    "authenticated",
  );
});

it("limits pairing starts separately from existing-session traffic", async () => {
  for (let i = 0; i < 10; i++) {
    invitation.id = i.toString(16).padStart(32, "0");
    expect((await create()).status).toBe(201);
  }
  invitation.id = "ff".repeat(16);
  expect((await create()).status).toBe(429);
  expect((await api()).status).toBe(404);
});
it("bounds unauthenticated sockets and releases admission after close", async () => {
  const idle = Array.from({ length: 64 }, () => client());
  await Promise.all(idle.map((c) => c.json()));
  await expect(client().next()).rejects.toThrow();
  const first = idle[0];
  if (!first) throw new Error("Missing fixture");
  const closed = once(first.socket, "close");
  first.socket.close();
  await closed;
  expect((await client().json()).type).toBe("challenge");
});
it("allows one phone management connection without displacing it", async () => {
  await enroll();
  const first = client();
  await first.login(phone, "phone", { mode: "registration" });
  await expect(
    client().login(phone, "phone", { mode: "registration" }),
  ).rejects.toThrow();
  expect(first.socket.readyState).toBe(WebSocket.OPEN);
});
it("keeps existing routes usable when the persistent enrollment budget is full", async () => {
  await enroll();
  const state = new RelayState(directory);
  const row = state.pairs()[invitation.id];
  if (!row) throw new Error("Missing fixture");
  for (let i = 0; i < 99; i++)
    state.putPair({ ...row, id: i.toString(16).padStart(32, "0") });
  state.close();
  await relay.close();
  await start();
  expect((await client().login(viewer, "viewer")).type).toBe("authenticated");
  invitation.id = "fe".repeat(16);
  expect((await create()).status).toBe(201);
  const grant = await offer();
  expect((await api("/offer", grant)).status).toBe(202);
  const response = await api("/complete", {
    viewerSignature: b64(await viewer.sign(grantBytes(origin, grant))),
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("3600");
});
it("fails closed when a durable authority write fails", async () => {
  await enroll();
  const state = new RelayState(directory);
  state.db.exec(
    "CREATE TRIGGER reject_write BEFORE UPDATE ON pairings BEGIN SELECT RAISE(ABORT, 'fixture'); END",
  );
  state.close();
  expect(
    (
      await api("/revoke", {
        signature: b64(await phone.sign(revokeBytes(origin, invitation.id))),
      })
    ).status,
  ).toBe(503);
  expect((await fetch(`${base}/health`)).status).toBe(503);
  await expect(client().next()).rejects.toThrow();
});
