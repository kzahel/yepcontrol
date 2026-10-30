import { type Command, encodeCommand } from "@remote/protocol/control";
/** Narrow public CLI surface; credentials, video and transport negotiation are not accepted. */
export function parseCommand(value: unknown): Command {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid control request");
  const v = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    status: [],
    snapshot: [],
    nodeClick: ["observation", "node"],
    nodeScroll: ["observation", "node", "direction"],
    nodeText: ["observation", "node", "text"],
    capture: [],
    wake: [],
    sleep: [],
    apps: [],
    release: [],
    tap: ["scene", "x", "y"],
    swipe: ["scene", "x", "y", "endX", "endY", "duration"],
    navigation: ["action"],
    text: ["text"],
    launch: ["packageName"],
  };
  const allowed = typeof v.op === "string" ? fields[v.op] : undefined;
  if (
    !allowed ||
    Object.keys(v).some((k) => k !== "op" && !allowed.includes(k)) ||
    allowed.some((k) => v[k] === undefined)
  )
    throw new Error("Unsupported or invalid control operation");
  if ((v.op === "text" || v.op === "nodeText") && typeof v.text !== "string")
    throw new Error("Invalid text");
  if (
    v.op === "navigation" &&
    !["home", "back", "recents"].includes(String(v.action))
  )
    throw new Error("Invalid navigation action");
  const command = value as Command;
  encodeCommand(1, command).fill(0);
  return command;
}

export function requireCapability(command: Command, state: { a11y?: 1 }) {
  if (
    (command.op === "snapshot" || command.op.startsWith("node")) &&
    state.a11y !== 1
  )
    throw new Error(
      "Update YepControl on the phone to use accessibility snapshots",
    );
  return command;
}
