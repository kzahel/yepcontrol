import { getEventListeners } from "node:events";
import type { Identity } from "@remote/protocol";
import type { Grant } from "@remote/protocol/enrollment";
import { expect, it, vi } from "vitest";
import { type Lane, RemoteSession } from "../src/control-session.js";

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
