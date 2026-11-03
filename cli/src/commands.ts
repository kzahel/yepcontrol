import { type Command, encodeCommand } from "@remote/protocol/control";
/** Narrow public CLI surface; credentials, video and transport negotiation are not accepted. */
export function parseCommand(value: unknown): Command {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid control request");
  const v = value as Record<string, unknown>;
  const fields: Record<string, string[]> = {
    status: [],
    snapshot: ["maxNodes?", "maxDepth?", "timeoutMs?"],
    query: ["selector", "maxNodes?", "maxDepth?", "maxMatches?", "timeoutMs?"],
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
    Object.keys(v).some(
      (k) =>
        k !== "op" && !allowed.some((field) => field.replace(/\?$/, "") === k),
    ) ||
    allowed.some((k) => !k.endsWith("?") && v[k] === undefined)
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

export function requireCapability(
  command: Command,
  state: { a11y?: 1; a11yQuery?: 1 },
) {
  if (
    (command.op === "query" ||
      (command.op === "snapshot" &&
        (command.maxNodes !== undefined ||
          command.maxDepth !== undefined ||
          command.timeoutMs !== undefined)) ||
      (command.op.startsWith("node") &&
        "node" in command &&
        command.node >= 128)) &&
    state.a11yQuery !== 1
  )
    throw Error(
      "Update YepControl on the phone to use accessibility queries and larger snapshots",
    );
  if (
    (command.op === "query" ||
      command.op === "snapshot" ||
      command.op.startsWith("node")) &&
    state.a11y !== 1
  )
    throw new Error(
      "Update YepControl on the phone to use accessibility snapshots",
    );
  return command;
}
