import {
  type Bytes,
  b64,
  type Channel,
  equal,
  type Identity,
  utf8,
  ViewerHandshake,
} from "@remote/protocol";
import {
  authBytes,
  fromHex,
  type Grant,
  keyBytes,
} from "@remote/protocol/enrollment";
import { type PhoneFeatures, parseFeatures } from "@remote/protocol/features";
import type { PhoneAccess } from "./store.js";

// Loaded lazily: the store opens IndexedDB, which this transport must not require.
const recordAccess = (grant: Grant, access: PhoneAccess | undefined) =>
  void import("./store.js")
    .then((store) => store.setPhoneAccess(grant, access))
    .catch(() => {});
/** Relay close codes, sent only after this browser proved its pinned key. */
const ACCESS_CLOSE: Record<number, [PhoneAccess, string]> = {
  4010: ["removed", "Access to this phone was removed on the phone."],
  4011: ["paused", "Access is paused on the phone."],
};

/** One ordered cryptographic lane. Callers serialize send/read and own teardown. */
export async function openEncryptedSession(
  identity: Identity,
  grant: Grant,
  report?: (message: string) => void,
  signal?: AbortSignal,
) {
  let active = true;
  const url = new URL("/api/socket", location.origin);
  url.protocol = "wss:";
  url.searchParams.set("id", grant.id);
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let relayFlow = false;
  type Frame =
    | Bytes
    | { type: string; nonce?: string; delivery?: string; relayFlow?: number };
  const queue: Frame[] = [];
  let queuedBytes = 0;
  let wake: (() => void) | undefined;
  let channel: Channel | undefined;
  let refusal: string | undefined;
  let ended: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const close = () => {
    active = false;
    ended?.();
    channel?.close();
    ws.close();
    wake?.();
    signal?.removeEventListener("abort", close);
  };
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) close();
  ws.onmessage = (event) => {
    if (!active) return;
    try {
      const frame: Frame =
        typeof event.data === "string"
          ? JSON.parse(event.data)
          : new Uint8Array(event.data as ArrayBuffer);
      if (!(frame instanceof Uint8Array) && frame.type === "relayReceipt") {
        if (!relayFlow || typeof frame.nonce !== "string")
          throw new Error("Relay receipt");
        fromHex(frame.nonce, 16);
        ws.send(JSON.stringify({ type: "relayAck", nonce: frame.nonce }));
        return;
      }
      queuedBytes +=
        typeof event.data === "string"
          ? event.data.length
          : event.data.byteLength;
      if (queuedBytes > 2097152 || queue.length >= 32)
        throw new Error("Slow receiver");
      queue.push(frame);
      wake?.();
    } catch {
      close();
    }
  };
  ws.onclose = (event) => {
    const access = ACCESS_CLOSE[event.code];
    if (access) {
      refusal = access[1];
      recordAccess(grant, access[0]);
    }
    close();
  };
  ws.onerror = close;
  async function receive(timeout: number): Promise<Frame | undefined> {
    const deadline = Date.now() + timeout;
    while (!queue.length && active && Date.now() < deadline)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    if (!active)
      throw new Error(refusal ?? "Connection ended. Reconnect to continue.");
    const value = queue.shift();
    if (value instanceof Uint8Array) {
      queuedBytes -= value.byteLength;
    } else if (value) queuedBytes -= JSON.stringify(value).length;
    return value;
  }
  async function next() {
    const value = await receive(70000);
    if (!value)
      throw new Error("Phone is unavailable. Open the app and try again.");
    return value;
  }
  const binary = async (): Promise<Bytes> => {
    const value = await next();
    if (!(value instanceof Uint8Array))
      throw new Error("Unexpected relay message");
    return value;
  };
  try {
    const challenge = await next();
    if (
      challenge instanceof Uint8Array ||
      challenge.type !== "challenge" ||
      !challenge.nonce
    )
      throw new Error("Invalid relay challenge");
    fromHex(challenge.nonce, 32);
    relayFlow = challenge.relayFlow === 1;
    const signature = b64(
      await identity.sign(
        authBytes(location.origin, grant.id, "viewer", challenge.nonce),
      ),
    );
    if (!active) throw new Error("Connection ended");
    ws.send(JSON.stringify({ id: grant.id, role: "viewer", signature }));
    report?.("Contacting phone…");
    let ready = false;
    while (!ready) {
      const value = await next();
      if (
        value instanceof Uint8Array ||
        !["authenticated", "contacting", "ready"].includes(value.type)
      )
        throw new Error("Invalid relay state");
      ready = value.type === "ready";
      if (value.type === "authenticated") recordAccess(grant, undefined);
      if (value.type === "contacting")
        report?.(
          value.delivery === "coalesced"
            ? "Waiting a moment before contacting your phone again…"
            : "Contacting phone…",
        );
    }
    const handshake = await ViewerHandshake.start(identity, {
      id: fromHex(grant.id, 16),
      generation: 1,
      peer: keyBytes(grant.phone),
      current: () => active,
    });
    ws.send(handshake.hello);
    ws.send(await handshake.answer(await binary()));
    channel = await handshake.finish(await binary());
    const established = channel;
    return {
      close,
      closed,
      get connected() {
        return active;
      },
      async send(bytes: Bytes) {
        if (!active || ws.bufferedAmount > 1048608)
          throw new Error("Connection ended or too slow");
        const record = await established.seal(bytes);
        if (!active) throw new Error("Connection ended");
        ws.send(record);
      },
      async read(timeout = 30000): Promise<Bytes | undefined> {
        const frame = await receive(timeout);
        if (!frame) return undefined;
        if (!(frame instanceof Uint8Array))
          throw new Error("Unexpected relay message");
        return established.open(frame);
      },
    };
  } catch (error) {
    close();
    throw error;
  }
}
export async function encryptedCheck(
  identity: Identity,
  grant: Grant,
  report?: (message: string) => void,
  signal?: AbortSignal,
): Promise<PhoneFeatures | undefined> {
  const session = await openEncryptedSession(identity, grant, report, signal);
  try {
    const canary = utf8("Encrypted connection check 🌞");
    await session.send(canary);
    const reply = await session.read();
    if (!reply || !equal(reply, canary))
      throw new Error("Connection check failed");
    const trailer = await session.read(1200);
    return trailer ? parseFeatures(trailer) : undefined;
  } finally {
    session.close();
  }
}

export type PreparedConnection = {
  features: PhoneFeatures;
  session: Awaited<ReturnType<typeof openEncryptedSession>>;
  expiresAt: number;
};

/** A single canary, followed by control on the same ordered encrypted lane. */
export async function prepareConnection(
  identity: Identity,
  grant: Grant,
  report: (message: string) => void,
  signal: AbortSignal,
): Promise<PreparedConnection> {
  const session = await openEncryptedSession(identity, grant, report, signal);
  try {
    // The phone enforces 30 s from completing the check. Start our slightly
    // shorter window before sending, leaving time to deliver a promotion.
    const expiresAt = Date.now() + 29000;
    const canary = utf8("Encrypted connection check 🌞");
    await session.send(canary);
    const reply = await session.read();
    if (!reply || !equal(reply, canary))
      throw new Error("Connection check failed");
    const trailer = await session.read(1200);
    const features = trailer ? parseFeatures(trailer) : undefined;
    if (features?.device.connectionPreparation !== 1)
      throw new Error("Update the phone app, then connect again.");
    return { features, session, expiresAt };
  } catch (error) {
    session.close();
    throw error;
  }
}
