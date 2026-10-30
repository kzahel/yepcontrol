import type { Identity } from "@remote/protocol";
import type { Grant } from "@remote/protocol/enrollment";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ relay: vi.fn(), direct: vi.fn() }));
vi.mock("../src/relay.js", () => ({ openEncryptedSession: mocks.relay }));
vi.mock("../src/direct-lane.js", () => ({ openDirectLane: mocks.direct }));

import { RemoteSession } from "../src/control-session.js";

function lane() {
  let id = 0,
    op = 0;
  const sent: number[] = [];
  let lostReplyOp: number | undefined;
  return {
    sent,
    loseReply(op: number) {
      lostReplyOp = op;
    },
    close: vi.fn(),
    send: vi.fn(async (bytes: Uint8Array<ArrayBuffer>) => {
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      id = view.getUint32(8);
      op = bytes[4] ?? 0;
      sent.push(op);
    }),
    read: vi.fn(async () => {
      if (op === lostReplyOp)
        throw new Error("Reply lost after possible native delivery");
      const payload =
        op === 19
          ? new TextEncoder().encode("v=0\r\nanswer")
          : [1, 2].includes(op)
            ? new TextEncoder().encode(
                JSON.stringify({
                  type: "state",
                  v: 1,
                  accessibility: true,
                  locked: false,
                  width: 1080,
                  height: 2400,
                  scene: 1,
                  device: {
                    manufacturer: "Google",
                    model: "Pixel 9",
                    name: "Pixel 9",
                    android: "17",
                    sdk: 37,
                    app: "0.6.0",
                  },
                }),
              )
            : new Uint8Array([0]);
      const result = new Uint8Array(12 + payload.length),
        view = new DataView(result.buffer);
      result.set([
        65,
        82,
        80,
        49,
        op === 19 ? 6 : [1, 2].includes(op) ? 1 : 2,
        0,
        0,
        0,
      ]);
      view.setUint32(8, id);
      result.set(payload, 12);
      return result;
    }),
  };
}
const identity = {} as Identity,
  grant = {} as Grant;
async function connect() {
  return (
    await RemoteSession.connect(
      identity,
      grant,
      vi.fn(),
      new AbortController().signal,
    )
  ).session;
}

describe("control path recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", class {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });
  it("promotes the prepared encrypted lane without opening another relay socket", async () => {
    const prepared = lane();
    const result = await RemoteSession.connect(
      identity,
      grant,
      vi.fn(),
      new AbortController().signal,
      prepared,
    );
    expect(mocks.relay).not.toHaveBeenCalled();
    expect(prepared.sent).toEqual([1]);
    expect(result.state.accessibility).toBe(true);
    expect(prepared.close).not.toHaveBeenCalled();
    result.session.close();
    expect(prepared.close).toHaveBeenCalledOnce();
  });
  it("keeps the hosted lane usable when direct setup fails", async () => {
    const hosted = lane();
    mocks.relay.mockResolvedValue(hosted);
    mocks.direct.mockRejectedValue(new Error("No direct route"));
    const session = await connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.path).toBe("relay");
    expect(session.connected).toBe(true);
    expect(hosted.close).not.toHaveBeenCalled();
    expect((await session.command({ op: "status" })).kind).toBe("state");
    session.close();
  });
  it.each([
    "tap",
    "unlockSaved",
  ] as const)("falls back after an uncertain direct %s without replaying it", async (op) => {
    const hosted = lane(),
      direct = lane();
    mocks.relay.mockResolvedValue(hosted);
    mocks.direct.mockImplementation(async (_identity, _grant, offer) => {
      expect(await offer("v=0\r\noffer")).toBe("v=0\r\nanswer");
      return direct;
    });
    const session = await connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.path).toBe("direct");
    const opcode = op === "tap" ? 4 : 14;
    direct.loseReply(opcode);
    await expect(
      session.command(op === "tap" ? { op, scene: 1, x: 20, y: 30 } : { op }),
    ).rejects.toThrow("not retried");
    expect(session.path).toBe("relay");
    expect(session.connected).toBe(true);
    expect(hosted.sent.filter((op) => op === opcode)).toHaveLength(0);
    expect(direct.sent.filter((op) => op === opcode)).toHaveLength(1);
    expect((await session.command({ op: "status" })).kind).toBe("state");
    expect(direct.close).toHaveBeenCalledOnce();
    session.close();
  });
});

describe("shared session lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetAllMocks();
  });
  it("does not open or send commands for a canceled connection", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      RemoteSession.connect(identity, grant, vi.fn(), controller.signal),
    ).rejects.toThrow();
    expect(mocks.relay).not.toHaveBeenCalled();
  });
  it("removes its listener and upgrade timer on explicit close", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", class {});
    const hosted = lane();
    mocks.relay.mockResolvedValue(hosted);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const { session } = await RemoteSession.connect(
      identity,
      grant,
      vi.fn(),
      controller.signal,
    );
    session.close();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.direct).not.toHaveBeenCalled();
    expect(hosted.close).toHaveBeenCalledOnce();
  });
  it("skips direct negotiation when WebRTC is absent", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", undefined);
    const hosted = lane();
    mocks.relay.mockResolvedValue(hosted);
    const session = await connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(hosted.sent).toEqual([1]);
    expect(mocks.direct).not.toHaveBeenCalled();
    session.close();
  });
});
