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
    { op: "nodeClick", observation, node: 4096 },
    { op: "nodeClick", observation: "bad", node: 1 },
    { op: "nodeScroll", observation, node: 1, direction: "down" },
    { op: "nodeText", observation, node: 1, text: "🌞".repeat(1025) },
  ])
    expect(() => encodeCommand(1, command as never)).toThrow();
});

it("keeps the legacy command unchanged and bounds larger observations and queries", () => {
  expect(encodeCommand(1, { op: "snapshot" })[4]).toBe(20);
  expect(encodeCommand(1, { op: "snapshot", maxNodes: 1024 })[4]).toBe(28);
  expect(
    encodeCommand(1, {
      op: "query",
      selector: { name: "Next", enabled: true },
    })[4],
  ).toBe(29);
  expect(
    encodeCommand(1, { op: "nodeClick", observation, node: 4095 }).length,
  ).toBe(32);
  for (const command of [
    { op: "snapshot", maxNodes: 4097 },
    { op: "snapshot", maxNodes: null },
    { op: "query", selector: { name: "Next" }, maxMatches: null },
    { op: "snapshot", maxDepth: 65 },
    { op: "snapshot", timeoutMs: 1501 },
    { op: "query", selector: {} },
    { op: "query", selector: { name: "" } },
    { op: "query", selector: { name: "x".repeat(257) } },
    { op: "query", selector: { enabled: "true" } },
    { op: "query", selector: { name: "Next", match: "regex" } },
    { op: "query", selector: { name: "Next", unknown: true } },
    { op: "query", selector: { name: "Next" }, maxMatches: 0 },
    { op: "query", selector: { name: "Next" }, maxMatches: 257 },
    { op: "query", selector: { name: "Next" }, maxNodes: NaN },
  ])
    expect(() => encodeCommand(1, command as never)).toThrow();
});
it("validates complete, empty, ambiguous and bounded query projections", () => {
  const nodes = Array.from({ length: 200 }, (_, i) => ({
    ...node,
    node: i,
    parent: i === 0 ? -1 : 0,
    password: false,
  }));
  const extended = {
    ...snapshot,
    nodes,
    scope: "window",
    windowId: 7,
    packageName: "com.example.fixture",
    visitedNodes: 200,
    limitReasons: [],
  };
  expect(parseSnapshot(extended).nodes.length).toBe(200);
  const query = { ...extended, scope: "query", nodes: [nodes[0]], matches: [] };
  expect(parseSnapshot(query).matches).toEqual([]);
  expect(
    parseSnapshot({ ...extended, scope: "query", matches: [1, 199] }).matches,
  ).toEqual([1, 199]);
  expect(
    parseSnapshot({ ...query, truncated: true, limitReasons: ["time"] })
      .truncated,
  ).toBe(true);
  for (const bad of [
    { ...query, matches: [1] },
    { ...query, matches: [0, 0] },
    { ...query, matches: [-1] },
    { ...extended, matches: [] },
    { ...query, visitedNodes: 0 },
    { ...query, visitedNodes: 4097 },
    { ...query, truncated: true },
    { ...query, limitReasons: ["time"] },
    { ...query, limitReasons: ["unknown"] },
    { ...query, nodes: [{ ...node, stateDescription: "secret" }] },
    { ...query, nodes: [{ ...nodes[0], enabled: "yes" }] },
  ])
    expect(() => parseSnapshot(bad)).toThrow();
});
