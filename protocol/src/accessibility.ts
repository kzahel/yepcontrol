/** Bounded, redacted active-window observation. References live only in one session. */
export type UiNode = {
  node: number;
  parent: number;
  role: string;
  text: string;
  label: string;
  viewId: string;
  bounds: [number, number, number, number];
  clickable: boolean;
  editable: boolean;
  scrollable: boolean;
  password: boolean;
};
export type UiSnapshot = {
  observation: string;
  expiresInMs: number;
  truncated: boolean;
  nodes: UiNode[];
};
export function validObservation(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}
export function parseSnapshot(value: unknown): UiSnapshot {
  const s = value as UiSnapshot;
  if (
    !s ||
    typeof s !== "object" ||
    !validObservation(s.observation) ||
    s.expiresInMs !== 30000 ||
    typeof s.truncated !== "boolean" ||
    !Array.isArray(s.nodes) ||
    s.nodes.length > 128 ||
    s.nodes.length < 1
  )
    throw new Error("Invalid UI snapshot");
  for (let i = 0; i < s.nodes.length; i++) {
    const n = s.nodes[i];
    if (
      !n ||
      n.node !== i ||
      !Number.isInteger(n.parent) ||
      n.parent < -1 ||
      n.parent >= i ||
      (i === 0 ? n.parent !== -1 : n.parent === -1) ||
      [n.role, n.text, n.label, n.viewId].some(
        (v) => typeof v !== "string" || v.length > 256,
      ) ||
      [n.clickable, n.editable, n.scrollable, n.password].some(
        (v) => typeof v !== "boolean",
      ) ||
      !Array.isArray(n.bounds) ||
      n.bounds.length !== 4 ||
      n.bounds.some((v) => !Number.isInteger(v) || Math.abs(v) > 1000000) ||
      n.bounds[0] > n.bounds[2] ||
      n.bounds[1] > n.bounds[3] ||
      (n.password &&
        (n.text !== "" ||
          n.label !== "" ||
          n.clickable ||
          n.editable ||
          n.scrollable))
    )
      throw new Error("Invalid UI node");
  }
  return s;
}
