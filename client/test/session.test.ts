import { getEventListeners } from "node:events";
import type { Identity } from "@remote/protocol";
import type { Grant } from "@remote/protocol/enrollment";
import { expect, it, vi } from "vitest";
import { type Lane, RemoteSession } from "../src/control-session.js";
import { phoneLane } from "./phone.js";

const identity = {} as Identity,
  grant = {} as Grant;
it("closes a lane returned after cancellation without sending start", async () => {
  const controller = new AbortController();
  const lane = { close: vi.fn(), send: vi.fn(), read: vi.fn() } as Lane;
  const open = vi.fn(async () => {
    controller.abort();
    return lane;
  });
  await expect(
    RemoteSession.connect(identity, grant, vi.fn(), controller.signal, {
      open,
    }),
  ).rejects.toThrow();
  expect(lane.close).toHaveBeenCalledOnce();
  expect(lane.send).not.toHaveBeenCalled();
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});
it("does not use a prepared lane after pre-cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const lane = { close: vi.fn(), send: vi.fn(), read: vi.fn() } as Lane;
  const open = vi.fn();
  await expect(
    RemoteSession.connect(
      identity,
      grant,
      vi.fn(),
      controller.signal,
      { open },
      lane,
    ),
  ).rejects.toThrow();
  expect(lane.send).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  expect(lane.close).toHaveBeenCalledOnce();
});

it("identifies a missing command reply when the relay stays connected", async () => {
  vi.useFakeTimers();
  const phone = phoneLane(false, (command) => command.op === 9);
  const trace = vi.fn();
  try {
    const { session } = await RemoteSession.connect(
      identity,
      grant,
      vi.fn(),
      new AbortController().signal,
      { open: async () => phone, onDiagnostic: trace },
    );
    try {
      const result = expect(session.command({ op: "wake" })).rejects.toThrow(
        "Phone did not respond",
      );
      await vi.advanceTimersByTimeAsync(15000);
      await result;
      expect(trace.mock.calls.slice(-3).map(([event]) => event)).toEqual([
        { event: "command.sending", sequence: 2, op: "wake" },
        { event: "command.sent", sequence: 2, op: "wake" },
        { event: "command.timeout", sequence: 2, op: "wake" },
      ]);
      expect(phone.sent).toEqual([1, 9]);
    } finally {
      session.close();
    }
  } finally {
    vi.useRealTimers();
  }
});
