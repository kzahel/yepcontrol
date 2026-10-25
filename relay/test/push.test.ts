import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type Delivery,
  firebaseDelivery,
  PushRegistry,
  validFid,
  wakeMessage,
} from "../src/push.js";

import { RelayState } from "../src/state.js";

let dir: string;
const states: RelayState[] = [];
function state() {
  const value = new RelayState(dir);
  states.push(value);
  return value;
}
const id = "ab".repeat(16);
const fid = `c${"a".repeat(21)}`;
const replacement = `d${"b".repeat(21)}`;
let now: number;
const hint = () => ({
  requestId: "cd".repeat(16),
  expires: Math.floor(now / 1000) + 60,
});
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "remote-push-"));
  now = Date.now();
});
afterEach(async () => {
  for (const value of states.splice(0)) value.close();
  await rm(dir, { recursive: true, force: true });
});
it("sends only a bounded visible-purpose hint, never control authority", () => {
  expect(wakeMessage(fid, hint())).toEqual({
    fid,
    data: {
      intent: "connect-v1",
      requestId: hint().requestId,
      expires: String(hint().expires),
    },
    android: { priority: "high", ttl: 60000, collapseKey: "connect-v1" },
  });
  expect(validFid("x".repeat(22))).toBe(false);
  expect(validFid(fid)).toBe(true);
});
it("persists refreshed targets and removes them on revocation", async () => {
  const send = vi.fn().mockResolvedValue("accepted");
  const registry = new PushRegistry(state(), send);
  registry.register(id, fid);
  registry.register(id, replacement);
  const restored = new PushRegistry(state(), send);
  expect(await restored.wake(id, hint())).toBe("accepted");
  expect(send).toHaveBeenCalledWith(replacement, hint());
  restored.remove(id);
  expect(await new PushRegistry(state(), send).wake(id, hint())).toBe(
    "unregistered",
  );
});
it("coalesces repeated wakes and refuses expired requests before sending", async () => {
  const send = vi.fn().mockResolvedValue("accepted");
  const registry = new PushRegistry(state(), send, () => now);
  registry.register(id, fid);
  expect(await registry.wake(id, { ...hint(), expires: 1 })).toBe(
    "unavailable",
  );
  expect(await registry.wake(id, hint())).toBe("accepted");
  expect(registry.retryAfterMs(id)).toBe(0);
  expect(await registry.wake(id, hint())).toBe("accepted");
  expect(registry.retryAfterMs(id)).toBe(30000);
  now += 5000;
  expect(await registry.wake(id, hint())).toBe("coalesced");
  expect(registry.retryAfterMs(id)).toBe(25000);
  expect(send).toHaveBeenCalledTimes(2);
  now += 31000;
  expect(registry.retryAfterMs(id)).toBe(0);
  expect(await registry.wake(id, hint())).toBe("accepted");
});
it("keeps a refreshed target when an old in-flight send rejects it", async () => {
  let complete: (result: Delivery) => void = () => {};
  const registry = new PushRegistry(
    state(),
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  registry.register(id, fid);
  const pending = registry.wake(id, hint());
  registry.register(id, replacement);
  complete("invalid_target");
  await pending;
  expect(JSON.stringify(state().targets())).toContain(replacement);
});
it("clears invalid registrations but retains transiently unavailable ones", async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce("unavailable")
    .mockResolvedValueOnce("invalid_target");
  const registry = new PushRegistry(state(), send, () => now);
  registry.register(id, fid);
  expect(await registry.wake(id, hint())).toBe("unavailable");
  now += 31000;
  expect(await registry.wake(id, hint())).toBe("invalid_target");
  expect(await registry.wake(id, hint())).toBe("unregistered");
});
it("bounds aggregate sends across pairings", async () => {
  const send = vi.fn().mockResolvedValue("accepted");
  const registry = new PushRegistry(state(), send, () => now);
  for (let i = 0; i < 101; i++) {
    const pair = i.toString(16).padStart(32, "0");
    registry.register(pair, fid);
    expect(await registry.wake(pair, hint())).toBe(
      i < 100 ? "accepted" : "unavailable",
    );
  }
  expect(send).toHaveBeenCalledTimes(100);
});

it("classifies provider outcomes without exposing credential or provider errors", async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce("provider-message-id")
    .mockRejectedValueOnce({
      code: "messaging/registration-token-not-registered",
    })
    .mockRejectedValueOnce({ code: "messaging/server-unavailable" })
    .mockRejectedValueOnce(null);
  const deliver = firebaseDelivery(send);
  expect(await deliver(fid, hint())).toBe("accepted");
  expect(await deliver(fid, hint())).toBe("invalid_target");
  expect(await deliver(fid, hint())).toBe("unavailable");
  expect(await deliver(fid, hint())).toBe("unavailable");
  expect(send).toHaveBeenCalledWith(wakeMessage(fid, hint()));
});
