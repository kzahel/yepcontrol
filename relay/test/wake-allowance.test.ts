import { expect, it } from "vitest";
import { takeWake } from "../src/wake-allowance.js";

it("allows one immediate reconnect, then refills at one wake per 30 seconds", () => {
  const first = takeWake(1000);
  const second = takeWake(1000, first.state);
  expect(first.retryAfterMs).toBe(0);
  expect(second.retryAfterMs).toBe(0);
  expect(takeWake(1000, second.state).retryAfterMs).toBe(30000);
  expect(takeWake(6000, second.state).retryAfterMs).toBe(25000);
  const replenished = takeWake(31000, second.state);
  expect(replenished.retryAfterMs).toBe(0);
  expect(takeWake(31000, replenished.state).retryAfterMs).toBe(30000);
  const idle = takeWake(300000, second.state);
  expect(takeWake(300000, idle.state).retryAfterMs).toBe(0);
  expect(
    takeWake(300000, takeWake(300000, idle.state).state).retryAfterMs,
  ).toBe(30000);
});

it("preserves a consumed request from the old durable numeric cooldown", () => {
  const legacyUntil = 31000;
  const previous = { tokens: 1, at: legacyUntil - 30000 };
  const retry = takeWake(6000, previous);
  expect(retry.retryAfterMs).toBe(0);
  expect(takeWake(6000, retry.state).retryAfterMs).toBe(25000);
});
