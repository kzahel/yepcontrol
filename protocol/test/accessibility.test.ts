import { expect, it } from "vitest";
import { parseSnapshot } from "../src/accessibility.js";
import { decodeReply, encodeCommand } from "../src/control.js";

const observation = "00112233445566778899aabbccddeeff";
const node = {
  node: 0,
  parent: -1,
  role: "EditText",
  text: "",
  label: "",
  viewId: "",
  bounds: [0, 0, 100, 100],
  clickable: false,
  editable: false,
  scrollable: false,
  password: true,
};
const snapshot = {
  observation,
  expiresInMs: 30000,
  truncated: false,
  nodes: [node],
};
it("bounds UI snapshots and rejects password disclosure and ambiguous references", () => {
  expect(parseSnapshot(snapshot)).toEqual(snapshot);
  for (const bad of [
    { ...snapshot, nodes: Array(129).fill(node) },
    { ...snapshot, observation: "old" },
    { ...snapshot, nodes: [{ ...node, text: "private" }] },
    { ...snapshot, nodes: [{ ...node, editable: true }] },
    { ...snapshot, nodes: [{ ...node, parent: 0 }] },
    { ...snapshot, nodes: [{ ...node, bounds: [0, 0, NaN, 0] }] },
    { ...snapshot, nodes: [{ ...node, label: "x".repeat(257) }] },
  ])
    expect(() => parseSnapshot(bad)).toThrow();
  const payload = new TextEncoder().encode(JSON.stringify(snapshot));
  const record = new Uint8Array(12 + payload.length);
  record.set([65, 82, 80, 49, 7, 0, 0, 0, 0, 0, 0, 1]);
  record.set(payload, 12);
  expect(decodeReply(record)).toEqual({ id: 1, kind: "snapshot", snapshot });
});
it("rejects malformed references and unbounded targeted text", () => {
  for (const command of [
    { op: "nodeClick", observation, node: 128 },
    { op: "nodeClick", observation: "bad", node: 1 },
    { op: "nodeScroll", observation, node: 1, direction: "down" },
    { op: "nodeText", observation, node: 1, text: "🌞".repeat(1025) },
  ])
    expect(() => encodeCommand(1, command as never)).toThrow();
});
