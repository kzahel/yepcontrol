import { expect, it } from "vitest";
import { parseCommand } from "../src/commands.js";

it("refuses out-of-scope operations and malformed input before dispatch", () => {
  for (const v of [
    { op: "unlock", pin: "1234" },
    { op: "directOffer", sdp: "v=0\r\n" },
    { op: "tap", scene: 0, x: 1, y: 2 },
    { op: "tap", scene: 1, x: NaN, y: 2 },
    { op: "navigation", action: "shutdown" },
    { op: "text", text: 5 },
    { op: "capture", extra: true },
  ])
    expect(() => parseCommand(v)).toThrow();
  expect(parseCommand({ op: "text", text: "Hello 🌞" })).toEqual({
    op: "text",
    text: "Hello 🌞",
  });
});

it("gates semantic commands before sending to a legacy public host", async () => {
  const { requireCapability } = await import("../src/commands.js");
  const snapshot = parseCommand({ op: "snapshot" });
  expect(() => requireCapability(snapshot, {})).toThrow("Update YepControl");
  expect(requireCapability(snapshot, { a11y: 1 })).toEqual(snapshot);
  expect(requireCapability(parseCommand({ op: "status" }), {})).toEqual({
    op: "status",
  });
});

it("requires the new capability only for extended observation and large references", async () => {
  const { requireCapability } = await import("../src/commands.js");
  for (const request of [
    { op: "snapshot", maxNodes: 1024 },
    { op: "query", selector: { name: "Next" } },
    { op: "nodeClick", observation: "0".repeat(32), node: 200 },
  ]) {
    const command = parseCommand(request);
    expect(() => requireCapability(command, { a11y: 1 })).toThrow(
      "Update YepControl",
    );
    expect(requireCapability(command, { a11y: 1, a11yQuery: 1 })).toEqual(
      command,
    );
  }
  expect(() => parseCommand({ op: "snapshot", maxMatches: 10 })).toThrow();
  expect(() =>
    parseCommand({ op: "query", selector: { text: "Next" }, anything: 1 }),
  ).toThrow();
});
