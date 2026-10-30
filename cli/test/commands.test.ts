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
