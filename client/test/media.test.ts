import type { Identity } from "@remote/protocol";
import type { Grant } from "@remote/protocol/enrollment";
import { afterEach, expect, it, vi } from "vitest";
import {
  type Lane,
  MediaError,
  RemoteSession,
} from "../src/control-session.js";
import { type NativeCommand, phoneLane } from "./phone.js";

const identity = {} as Identity,
  grant = {} as Grant;
const jpeg = new Uint8Array([255, 216, 255, 217]);
const pcm = new Uint8Array([1, 0, 2, 0]);
const sessions: RemoteSession[] = [];
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
async function connect(
  phone: ReturnType<typeof phoneLane>,
  direct?: (
    identity: Identity,
    grant: Grant,
    offer: (sdp: string) => Promise<string>,
    signal: AbortSignal,
  ) => Promise<Lane>,
) {
  const { session } = await RemoteSession.connect(
    identity,
    grant,
    () => {},
    new AbortController().signal,
    { open: async () => phone, ...(direct ? { direct } : {}) },
  );
  sessions.push(session);
  return session;
}
afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  vi.useRealTimers();
});

it("refuses old hosts locally while keeping ordinary control usable", async () => {
  const phone = phoneLane(false),
    session = await connect(phone);
  await expect(session.startCamera()).rejects.toMatchObject({
    code: "unsupported",
  });
  await expect(
    session.command({
      op: "cameraStart",
      stream: 1,
      facing: "rear",
      format: "jpeg",
      fps: 1,
    }),
  ).rejects.toBeInstanceOf(MediaError);
  expect(phone.sent).not.toContain(24);
  expect((await session.command({ op: "status" })).kind).toBe("state");
  expect(phone.maxReads).toBe(1);
});

it("demultiplexes media and out-of-order Stop replies while an ordinary action awaits its result", async () => {
  let held: NativeCommand | undefined;
  const phone = phoneLane(true, (command) => {
    if (command.op === 3) {
      held = command;
      return true;
    }
    return false;
  });
  const session = await connect(phone),
    camera = await session.startCamera({ format: "jpeg" }),
    mic = await session.startMicrophone();
  const action = session.command({ op: "capture" });
  await phone.untilCommand(3);
  phone.media(camera.id, "jpeg", jpeg);
  phone.media(mic.id, "pcm", pcm);
  expect((await camera.read())?.data).toEqual(jpeg);
  expect((await mic.read())?.data).toEqual(pcm);
  await camera.stop();
  await mic.stop();
  expect(phone.streams.size).toBe(0);
  expect(held).toBeDefined();
  phone.reply(held?.id ?? 0, 2, new Uint8Array([4]));
  expect(await action).toMatchObject({ kind: "result", code: 4 });
  expect(phone.maxReads).toBe(1);
  expect(phone.maxWrites).toBe(1);
  expect(phone.commands.map((c) => c.id)).toEqual(
    [...phone.commands.map((c) => c.id)].sort((a, b) => a - b),
  );
});

it("bounds an abandoned subscription and sends native Stop despite a pending ordinary reply", async () => {
  let held: NativeCommand | undefined;
  const phone = phoneLane(true, (command) => {
    if (command.op === 3) {
      held = command;
      return true;
    }
    return false;
  });
  const session = await connect(phone),
    camera = await session.startCamera({ format: "jpeg" });
  const action = session.command({ op: "capture" });
  await phone.untilCommand(3);
  for (let i = 0; i < 5; i++) phone.media(camera.id, "jpeg", jpeg);
  expect(await camera.closed).toBe("interrupted");
  await phone.untilCommand(26);
  expect(phone.streams.size).toBe(0);
  expect(camera.phase).toBe("off");
  expect(await camera.read()).toBeUndefined();
  phone.reply(held?.id ?? 0);
  await action;
  expect(session.connected).toBe(true);
});

it("cancels queued starts without sending them or closing ordinary control", async () => {
  let held: NativeCommand | undefined;
  const phone = phoneLane(true, (command) => {
    if (command.op === 3) {
      held = command;
      return true;
    }
    return false;
  });
  const session = await connect(phone),
    action = session.command({ op: "capture" });
  await phone.untilCommand(3);
  const cancel = new AbortController();
  const opening = session.startCamera({
    format: "jpeg",
    signal: cancel.signal,
  });
  const rejected = expect(opening).rejects.toMatchObject({
    name: "AbortError",
  });
  cancel.abort();
  phone.reply(held?.id ?? 0);
  await action;
  await rejected;
  expect(phone.sent).not.toContain(24);
  expect(session.connected).toBe(true);
});

it("cancels a sent-but-unacknowledged start with a priority Stop and no replay", async () => {
  let held: NativeCommand | undefined;
  const phone = phoneLane(true, (command) => {
    if (command.op === 24) {
      held = command;
      return true;
    }
    return false;
  });
  const session = await connect(phone),
    cancel = new AbortController();
  const opening = session.startCamera({
    format: "jpeg",
    signal: cancel.signal,
  });
  const rejected = expect(opening).rejects.toMatchObject({
    name: "AbortError",
  });
  const command = await phone.untilCommand(24);
  phone.openStream(command.stream, "jpeg");
  cancel.abort();
  await phone.untilCommand(26);
  phone.reply(held?.id ?? 0);
  await rejected;
  expect(phone.streams.size).toBe(0);
  expect(phone.sent.filter((op) => op === 24)).toHaveLength(1);
  expect(session.connected).toBe(true);
});

it("settles the initial direct path before any native media start and cancels its delayed upgrade", async () => {
  const relay = phoneLane(),
    direct = phoneLane(),
    gate = deferred<Lane>(),
    entered = deferred<void>();
  const adapter = vi.fn(
    async (
      _i: Identity,
      _g: Grant,
      offer: (sdp: string) => Promise<string>,
    ) => {
      await offer("v=0\r\noffer");
      entered.resolve();
      return gate.promise;
    },
  );
  const session = await connect(relay, adapter);
  const opening = session.startCamera({ format: "jpeg" });
  await entered.promise;
  expect(relay.sent).not.toContain(24);
  expect(direct.sent).not.toContain(24);
  gate.resolve(direct);
  const camera = await opening;
  expect(session.path).toBe("direct");
  expect(direct.sent.filter((op) => op === 24)).toHaveLength(1);
  expect(relay.sent).not.toContain(24);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  expect(adapter).toHaveBeenCalledOnce();
  expect(camera.active).toBe(true);
  await camera.stop();
});

it("ends media on direct loss and recovers ordinary control without restarting a sensor", async () => {
  const relay = phoneLane(),
    direct = phoneLane();
  const session = await connect(relay, async (_i, _g, offer) => {
    await offer("v=0\r\noffer");
    return direct;
  });
  const camera = await session.startCamera({ format: "jpeg" });
  direct.fail();
  expect(await camera.closed).toBe("disconnected");
  expect((await session.command({ op: "status" })).kind).toBe("state");
  expect(session.path).toBe("relay");
  expect(session.connected).toBe(true);
  expect(relay.sent).not.toContain(24);
  expect(direct.sent.filter((op) => op === 24)).toHaveLength(1);
  const next = await session.startCamera({ format: "jpeg" });
  expect(next.id).toBeGreaterThan(camera.id);
  relay.media(camera.id, "jpeg", jpeg, 9); // Delayed old-owner packet cannot enter the new subscription.
  relay.media(next.id, "jpeg", jpeg);
  expect((await next.read())?.stream).toBe(next.id);
  expect(direct.close).toHaveBeenCalledOnce();
  await next.stop();
});

it("rejects replayed stream sequences and releases every subscription", async () => {
  const phone = phoneLane(),
    session = await connect(phone),
    camera = await session.startCamera({ format: "jpeg" });
  phone.media(camera.id, "jpeg", jpeg, 2);
  await camera.read();
  phone.media(camera.id, "jpeg", jpeg, 2);
  expect(await camera.closed).toBe("disconnected");
  expect(session.connected).toBe(false);
  expect(phone.streams.size).toBe(0);
});

it("renews only an explicit live owner and removes all timers on close", async () => {
  vi.useFakeTimers();
  const phone = phoneLane(),
    session = await connect(phone);
  await vi.advanceTimersByTimeAsync(5000);
  expect(phone.sent).not.toContain(27);
  const mic = await session.startMicrophone();
  await vi.advanceTimersByTimeAsync(5000);
  expect(
    phone.commands.filter((c) => c.op === 27).map((c) => c.stream),
  ).toEqual([mic.id]);
  await mic.stop();
  session.close();
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a healthy microphone and screen owner after invalid camera options", async () => {
  const phone = phoneLane(),
    session = await connect(phone),
    mic = await session.startMicrophone();
  await expect(
    session.startCamera({ format: "jpeg", fps: 6 }),
  ).rejects.toMatchObject({ code: "unavailable" });
  expect(session.connected).toBe(true);
  expect(mic.active).toBe(true);
  expect(phone.sent).not.toContain(24);
  await mic.stop();
});

it("preserves the native terminal reason when a rejected renewal precedes resource release", async () => {
  vi.useFakeTimers();
  const phone = phoneLane(true, (command) => {
    if (command.op === 27) {
      phone.reply(command.id, 2, new Uint8Array([4]));
      return true;
    }
    if (command.op === 26) {
      phone.reply(command.id); // Resource release and its terminal event are asynchronous.
      return true;
    }
    return false;
  });
  const session = await connect(phone),
    camera = await session.startCamera({ format: "jpeg" });
  await vi.advanceTimersByTimeAsync(5000);
  expect(phone.sent).toContain(26);
  expect(camera.active).toBe(true);
  phone.media(camera.id, "event", new Uint8Array([3, 2]));
  expect(await camera.closed).toBe("disabled");
  expect(session.connected).toBe(true);
});

it("closes an uncertain owner when overflow Stop is acknowledged without native release", async () => {
  vi.useFakeTimers();
  const phone = phoneLane(true, (command) => {
    if (command.op !== 26) return false;
    phone.reply(command.id);
    return true; // ACK does not prove native cleanup completed.
  });
  const session = await connect(phone),
    camera = await session.startCamera({ format: "jpeg" });
  for (let i = 0; i < 5; i++) phone.media(camera.id, "jpeg", jpeg);
  await vi.advanceTimersByTimeAsync(1);
  expect(phone.sent).toContain(26);
  expect(camera.active).toBe(true);
  for (let i = 0; i < 12; i++) phone.media(camera.id, "jpeg", jpeg);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await camera.closed).toBe("timeout");
  expect(session.connected).toBe(false);
  expect(phone.streams.size).toBe(0);
});

it("closes the native owner when automatic renewal cannot enter a saturated priority queue", async () => {
  vi.useFakeTimers();
  const phone = phoneLane(true, (command) => command.op === 27);
  const session = await connect(phone),
    mic = await session.startMicrophone();
  const held = Array.from({ length: 4 }, () =>
    session
      .command({ op: "mediaRenew", stream: mic.id })
      .catch(() => undefined),
  );
  await vi.advanceTimersByTimeAsync(1);
  expect(phone.sent.filter((op) => op === 27)).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await mic.closed).toBe("disconnected");
  expect(session.connected).toBe(false);
  expect(phone.close).toHaveBeenCalledOnce();
  expect(phone.streams.size).toBe(0);
  await Promise.all(held);
});
