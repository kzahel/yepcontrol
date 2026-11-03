/** Bounded, redacted active-window observations. References live only in one session. */
export const MAX_UI_NODES = 4096;
export type UiLimits = {
  maxNodes?: number;
  maxDepth?: number;
  timeoutMs?: number;
};
export type UiSelector = {
  name?: string;
  text?: string;
  label?: string;
  viewId?: string;
  role?: string;
  match?: "exact" | "contains";
  clickable?: boolean;
  editable?: boolean;
  scrollable?: boolean;
  enabled?: boolean;
  checked?: boolean;
  selected?: boolean;
};
export function observationLimits(limits: UiLimits, query = false) {
  if (
    (["maxNodes", "maxDepth", "timeoutMs"] as const).some(
      (key) => limits[key] !== undefined && typeof limits[key] !== "number",
    )
  )
    throw Error("Invalid observation limits");
  const values = [
    limits.maxNodes ?? (query ? 2048 : 512),
    limits.maxDepth ?? 32,
    limits.timeoutMs ?? 1000,
  ];
  if (
    values.some(
      (v, i) =>
        !Number.isInteger(v) ||
        v < (i === 2 ? 10 : 1) ||
        v > ([MAX_UI_NODES, 64, 1500][i] ?? 0),
    )
  )
    throw Error("Invalid observation limits");
  return values as [number, number, number];
}
export function parseSelector(value: unknown): UiSelector {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid UI selector");
  const selector = value as Record<string, unknown>;
  const strings = ["name", "text", "label", "viewId", "role"];
  const flags = [
    "clickable",
    "editable",
    "scrollable",
    "enabled",
    "checked",
    "selected",
  ];
  if (
    !Object.keys(selector).some((key) =>
      [...strings, ...flags].includes(key),
    ) ||
    Object.keys(selector).some(
      (key) => ![...strings, ...flags, "match"].includes(key),
    ) ||
    strings.some(
      (key) =>
        selector[key] !== undefined &&
        (typeof selector[key] !== "string" ||
          !(selector[key] as string).length ||
          (selector[key] as string).length > 256),
    ) ||
    flags.some(
      (key) =>
        selector[key] !== undefined && typeof selector[key] !== "boolean",
    ) ||
    (selector.match !== undefined &&
      !["exact", "contains"].includes(String(selector.match)))
  )
    throw Error("Invalid UI selector");
  return value as UiSelector;
}
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
  enabled?: boolean;
  checked?: boolean;
  selected?: boolean;
  checkable?: boolean;
  stateDescription?: string;
};
export type UiSnapshot = {
  observation: string;
  expiresInMs: number;
  truncated: boolean;
  nodes: UiNode[];
  scope?: "window" | "query";
  visitedNodes?: number;
  windowId?: number;
  packageName?: string;
  limitReasons?: string[];
  matches?: number[];
};
export function validObservation(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}
export function parseSnapshot(value: unknown): UiSnapshot {
  const s = value as UiSnapshot;
  const extended = s?.scope !== undefined;
  if (
    !s ||
    typeof s !== "object" ||
    !validObservation(s.observation) ||
    s.expiresInMs !== 30000 ||
    typeof s.truncated !== "boolean" ||
    !Array.isArray(s.nodes) ||
    s.nodes.length > (extended ? MAX_UI_NODES : 128) ||
    s.nodes.length < 1
  )
    throw Error("Invalid UI snapshot");
  if (
    extended &&
    (!["window", "query"].includes(String(s.scope)) ||
      !Number.isInteger(s.windowId) ||
      (s.windowId ?? -1) < 0 ||
      (s.windowId ?? 0) > 0x7fffffff ||
      typeof s.packageName !== "string" ||
      s.packageName.length > 256 ||
      !Number.isInteger(s.visitedNodes) ||
      (s.visitedNodes ?? 0) < s.nodes.length ||
      (s.visitedNodes ?? 0) > MAX_UI_NODES ||
      !Array.isArray(s.limitReasons) ||
      s.limitReasons.length > 7 ||
      new Set(s.limitReasons).size !== s.limitReasons.length ||
      s.limitReasons.some(
        (v) =>
          ![
            "nodes",
            "depth",
            "time",
            "matches",
            "bytes",
            "lookups",
            "unavailable",
          ].includes(v),
      ) ||
      s.truncated !== s.limitReasons.length > 0)
  )
    throw Error("Invalid observation completeness");
  if (s.scope === "query") {
    if (
      !Array.isArray(s.matches) ||
      s.matches.length > 256 ||
      new Set(s.matches).size !== s.matches.length ||
      s.matches.some(
        (id) => !Number.isInteger(id) || id < 0 || id >= s.nodes.length,
      )
    )
      throw Error("Invalid query matches");
  } else if (s.matches !== undefined) throw Error("Unexpected query matches");
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
      [n.enabled, n.checked, n.selected, n.checkable].some(
        (v) => v !== undefined && typeof v !== "boolean",
      ) ||
      (n.stateDescription !== undefined &&
        (typeof n.stateDescription !== "string" ||
          n.stateDescription.length > 256)) ||
      !Array.isArray(n.bounds) ||
      n.bounds.length !== 4 ||
      n.bounds.some((v) => !Number.isInteger(v) || Math.abs(v) > 1000000) ||
      n.bounds[0] > n.bounds[2] ||
      n.bounds[1] > n.bounds[3] ||
      (n.password &&
        (n.text !== "" ||
          n.label !== "" ||
          (n.stateDescription ?? "") !== "" ||
          n.clickable ||
          n.editable ||
          n.scrollable))
    )
      throw Error("Invalid UI node");
  }
  return s;
}
