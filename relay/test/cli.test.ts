/** Real CLI process, HTTPS relay and cryptographic phone simulator; native effects are qualified separately. */
import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import os from "node:os";
import path from "node:path";
import {
  b64,
  createIdentity,
  type Identity,
  PhoneHandshake,
} from "@remote/protocol";
import { sealDevice } from "@remote/protocol/device";
import {
  authBytes,
  decodeInvitation,
  fromHex,
  type Grant,
  grantBytes,
  grantMac,
  hex,
  type Invitation,
} from "@remote/protocol/enrollment";
import {
  type BrowserClaim,
  encodePhoneInvitation,
  phoneCreateBytes,
  verifyClaim,
} from "@remote/protocol/phone-invitation";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createRelay } from "../src/server.js";

let directory: string,
  origin: string,
  base: string,
  phone: Identity,
  relay: ReturnType<typeof createRelay>,
  tls: ReturnType<typeof createServer>;
const children: ChildProcessWithoutNullStreams[] = [],
  sockets: WebSocket[] = [];
const device = {
  manufacturer: "Google",
  model: "Fixture",
  name: "Test phone",
  android: "15",
  sdk: 35,
  app: "0.9.0",
};
async function until<T>(
  f: () => Promise<T>,
  timeout = 10000,
): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v as NonNullable<T>;
    } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("CLI fixture timed out");
}
const api = (id: string, action = "", body?: unknown) =>
  fetch(
    `${base}/api/pair/${id}${action ? `/${action}` : ""}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
function cli(args: string[]) {
  const child = spawn(
    process.execPath,
    ["--conditions=development", "--import", "tsx", "cli/src/main.ts", ...args],
    {
      env: {
        ...process.env,
        YEPCONTROL_HOME: path.join(directory, "client"),
        NODE_EXTRA_CA_CERTS: path.join(directory, "cert.pem"),
      },
    },
  );
  children.push(child);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d;
  });
  child.stderr.on("data", (d) => {
    stderr += d;
  });
  const done = once(child, "exit").then(([code]) => ({ code, stdout, stderr }));
  return { child, done, stdout: () => stdout };
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "yep-cli-wire-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      path.join(directory, "key.pem"),
      "-out",
      path.join(directory, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  tls = createServer(
    {
      key: await readFile(path.join(directory, "key.pem")),
      cert: await readFile(path.join(directory, "cert.pem")),
    },
    (req, res) => relay.server.emit("request", req, res),
  );
  tls.on("upgrade", (req, socket, head) =>
    relay.server.emit("upgrade", req, socket, head),
  );
  tls.listen(0, "127.0.0.1");
  await once(tls, "listening");
  const a = tls.address();
  if (!a || typeof a === "string") throw Error("No TLS port");
  origin = `https://127.0.0.1:${a.port}`;
  relay = createRelay({ origin, stateDir: path.join(directory, "relay") });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const b = relay.server.address();
  if (!b || typeof b === "string") throw Error("No relay port");
  base = `http://127.0.0.1:${b.port}`;
  phone = await createIdentity();
});
afterEach(async () => {
  for (const c of children.splice(0))
    if (c.exitCode === null) c.kill("SIGKILL");
  for (const s of sockets.splice(0)) s.terminate();
  await relay.close();
  tls.closeAllConnections();
  await new Promise<void>((resolve) => tls.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});
async function offer(i: Invitation) {
  const grant: Grant = {
    id: i.id,
    viewer: i.viewer,
    phone: b64(phone.publicKey),
    expires: i.expires,
    mac: "",
    phoneSignature: "",
  };
  grant.mac = hex(await grantMac(i.secret, grantBytes(origin, grant)));
  grant.phoneSignature = b64(await phone.sign(grantBytes(origin, grant)));
  expect(
    (
      await api(i.id, "offer", {
        ...grant,
        device: await sealDevice(i.secret, i.id, device),
      })
    ).status,
  ).toBe(202);
  return grant;
}
async function pairCli() {
  const file = path.join(directory, "code.txt");
  const c = cli([
    "pair",
    "--origin",
    origin,
    "--name",
    "Test CLI",
    "--code-file",
    file,
  ]);
  const uri = await until(() => readFile(file, "utf8"));
  const invite = decodeInvitation(uri.trim());
  const grant = await offer(invite);
  const result = await c.done;
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).not.toContain(invite.secret);
  return grant;
}
async function host(grant: Grant, drop = false) {
  const ws = new WebSocket(`${origin.replace("https:", "wss:")}/api/socket`, {
    ca: await readFile(path.join(directory, "cert.pem")),
  });
  sockets.push(ws);
  const queue: Buffer[] = [];
  let wake: (() => void) | undefined;
  ws.on("message", (data) => {
    queue.push(Buffer.from(data as Buffer));
    wake?.();
  });
  const next = async () => {
    await until(async () => {
      if (queue.length) return true;
      await new Promise<void>((r) => {
        const t = setTimeout(r, 30);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
      return queue.length > 0;
    });
    return new Uint8Array(queue.shift() ?? []);
  };
  const challenge = JSON.parse(Buffer.from(await next()).toString());
  ws.send(
    JSON.stringify({
      id: grant.id,
      role: "phone",
      signature: b64(
        await phone.sign(authBytes(origin, grant.id, "phone", challenge.nonce)),
      ),
    }),
  );
  expect(JSON.parse(Buffer.from(await next()).toString()).type).toBe(
    "authenticated",
  );
  let actions = 0;
  // Defer the handshake until a viewer attaches; keep task errors visible to the caller.
  const serve = async () => {
    expect(JSON.parse(Buffer.from(await next()).toString()).type).toBe("ready");
    const h = await PhoneHandshake.start(
      phone,
      {
        id: fromHex(grant.id, 16),
        generation: 1,
        peer: Uint8Array.from(Buffer.from(grant.viewer, "base64")),
        current: () => true,
      },
      await next(),
    );
    ws.send(h.offer);
    const accepted = await h.finish(await next());
    ws.send(accepted.finish);
    while (ws.readyState === WebSocket.OPEN) {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await accepted.channel.open(await next());
      } catch {
        return;
      }
      const id = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8),
        op = bytes[4];
      if (op !== 1 && op !== 2) actions++;
      if (drop && op === 6) {
        ws.close();
        return;
      }
      const payload =
        op === 1 || op === 2
          ? new TextEncoder().encode(
              JSON.stringify({
                type: "state",
                v: 1,
                accessibility: true,
                locked: false,
                width: 1080,
                height: 2400,
                scene: 1,
                device,
              }),
            )
          : new Uint8Array([0]);
      const reply = new Uint8Array(12 + payload.length);
      reply.set([65, 82, 80, 49, op === 1 || op === 2 ? 1 : 2, 0, 0, 0]);
      new DataView(reply.buffer).setUint32(8, id);
      reply.set(payload, 12);
      ws.send(await accepted.channel.seal(reply));
    }
  };
  return { serve, actions: () => actions };
}
it("pairs from a private terminal code and persists the identity across CLI processes", async () => {
  const grant = await pairCli();
  const h = await host(grant);
  const serving = h.serve();
  const c = cli(["status"]);
  const result = await c.done;
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).state.device).toEqual(device);
  sockets.at(-1)?.terminate();
  await serving;
  const list = await cli(["phones"]).done;
  expect(JSON.parse(list.stdout).phones[0].id).toBe(grant.id);
}, 20000);
it("claims a phone-issued code using a distinct signed CLI identity", async () => {
  const invite = {
    v: 1 as const,
    origin,
    id: hex(crypto.getRandomValues(new Uint8Array(16))),
    secret: hex(crypto.getRandomValues(new Uint8Array(32))),
    phone: b64(phone.publicKey),
    expires: Math.floor(Date.now() / 1000) + 300,
  };
  expect(
    (
      await api(invite.id, "invite", {
        phone: invite.phone,
        expires: invite.expires,
        signature: b64(await phone.sign(phoneCreateBytes(origin, invite))),
      })
    ).status,
  ).toBe(201);
  const c = cli(["pair", "--origin", origin, "--from-stdin"]);
  c.child.stdin.end(encodePhoneInvitation(invite));
  const claim = await until(
    async () =>
      ((await (await api(invite.id)).json()) as { claim?: BrowserClaim }).claim,
  );
  await verifyClaim(invite, claim);
  await offer({ ...invite, viewer: claim.viewer, name: claim.name });
  const result = await c.done;
  expect(result.code, result.stderr).toBe(0);
}, 20000);
it("does not replay an action whose encrypted reply is lost", async () => {
  const grant = await pairCli();
  const h = await host(grant, true);
  const serving = h.serve();
  const c = cli(["session", "--stdio"]);
  await until(async () => c.stdout().includes('"type":"ready"'));
  c.child.stdin.end(
    `${JSON.stringify({ id: "action", op: "navigation", action: "home" })}\n`,
  );
  const result = await c.done;
  await serving;
  expect(result.code).toBe(1);
  expect(h.actions()).toBe(1);
  expect(result.stdout).toContain('"ok":false');
}, 20000);

it("cancels while waiting for a pairing link on stdin without hanging", async () => {
  const c = cli(["pair", "--origin", origin, "--from-stdin", "--json"]);
  await until(() =>
    readFile(path.join(directory, "client/state.json"), "utf8"),
  );
  c.child.kill("SIGINT");
  const result = await c.done;
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error.code).toBe("CLI_ERROR");
  expect(result.stderr).not.toContain("node:internal");
}, 10000);

it("reports sanitized failed pairing in JSON mode", async () => {
  const c = cli(["pair", "--from-stdin", "--json"]);
  c.child.stdin.end("private-invalid-code");
  const result = await c.done;
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stderr).error.message).toBe(
    "Invalid phone pairing code",
  );
  expect(result.stderr).not.toContain("private-invalid-code");
});
