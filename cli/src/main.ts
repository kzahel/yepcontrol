#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { RemoteSession } from "@remote/client/control-session";
import { openEncryptedSession } from "@remote/client/relay";
import { type Reply, resultMessage } from "@remote/protocol/control";
import { encode } from "uqr";
import { parseCommand, requireCapability } from "./commands.js";
import { output as writeOutput } from "./output.js";
import { pair } from "./pair.js";
import { privateArtifact, Store } from "./store.js";

const help = `YepControl CLI (Node 24+)
  pair [--name NAME] [--from-stdin | --code-file PATH] [--origin HTTPS_ORIGIN]
  phones
  status | snapshot | screenshot [--out PATH] | apps | wake | sleep
  tap X Y --scene N
  swipe X Y END_X END_Y DURATION_MS --scene N
  text --from-stdin
  home | back | recents | launch PACKAGE
  session --stdio      JSON lines: {"id":"1","op":"capture"}
Options: --phone ID, --json (fatal errors are JSON on stderr), --help
State: YEPCONTROL_HOME or ~/.config/yepcontrol (owner-only).
Pairing links and text use stdin, never command arguments. Screenshots return JPEG
base64 in session replies, or an owner-only --out artifact in screenshot mode.
`;
async function* lines(stream: NodeJS.ReadableStream, max: number) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([
      pending,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    let at = pending.indexOf(10);
    while (at >= 0) {
      if (at > max) throw new Error("Input line too long");
      yield pending.subarray(0, at).toString("utf8");
      pending = pending.subarray(at + 1);
      at = pending.indexOf(10);
    }
    if (pending.length > max) throw new Error("Input line too long");
  }
  if (pending.length) yield pending.toString("utf8");
}
async function readInput(max: number) {
  let value = "";
  for await (const line of lines(process.stdin, max)) {
    value += `${line}\n`;
    if (Buffer.byteLength(value) > max) throw new Error("Input too long");
  }
  return value.replace(/\r?\n$/, "");
}
function serialize(reply: Reply) {
  if (reply.kind === "image")
    return { ...reply, jpeg: Buffer.from(reply.jpeg).toString("base64") };
  if (reply.kind === "result")
    return { ...reply, message: resultMessage(reply.code) };
  return reply;
}
async function main() {
  const argumentsForCli = () =>
    parseArgs({
      allowPositionals: true,
      options: {
        help: { type: "boolean" },
        json: { type: "boolean" },
        phone: { type: "string" },
        origin: { type: "string" },
        name: { type: "string" },
        "from-stdin": { type: "boolean" },
        "code-file": { type: "string" },
        out: { type: "string" },
        scene: { type: "string" },
        stdio: { type: "boolean" },
      },
    });
  let parsed: ReturnType<typeof argumentsForCli>;
  try {
    parsed = argumentsForCli();
  } catch {
    throw new Error("Invalid arguments; use --help");
  }
  const { values, positionals } = parsed;
  const [action, ...args] = positionals;
  if (values.help || !action) {
    process.stdout.write(help);
    return;
  }
  const controller = new AbortController();
  const output = (value: unknown) => writeOutput(value, controller.signal);
  const stop = () => {
    controller.abort(new Error("Canceled"));
    process.stdin.destroy();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timeout = setTimeout(stop, action === "pair" ? 310000 : 3600000);
  timeout.unref();
  let session: RemoteSession | undefined;
  try {
    const store = await Store.load(
      path.resolve(
        process.env.YEPCONTROL_HOME ??
          path.join(os.homedir(), ".config/yepcontrol"),
      ),
    );
    if (action === "phones") {
      await output({
        phones: store.phones().map((p) => ({
          id: p.id,
          origin: p.origin,
          device: p.device,
          confirmed: p.confirmed,
        })),
      });
      return;
    }
    if (action === "pair") {
      if (values["from-stdin"] && values["code-file"])
        throw new Error("Choose one pairing input/output mode");
      const uri = values["from-stdin"] ? await readInput(4096) : undefined;
      const result = await pair(
        store,
        values.origin ?? "https://yepcontrol.com",
        values.name ?? "YepControl CLI",
        controller.signal,
        async (uri) => {
          if (values["code-file"]) {
            await privateArtifact(values["code-file"], `${uri}\n`);
            process.stderr.write(
              "Pairing link written to private code file. Scan it with YepControl.\n",
            );
            return;
          }
          const qr = encode(uri, { ecc: "M" });
          process.stderr.write("Scan with YepControl on the phone:\n");
          for (let y = -2; y < qr.size + 2; y++) {
            let row = "";
            for (let x = -2; x < qr.size + 2; x++)
              row += qr.data[y]?.[x] ? "  " : "██";
            process.stderr.write(`${row}\n`);
          }
        },
        uri,
      );
      await output({ paired: true, id: result.id, device: result.device });
      return;
    }
    if (action === "session" && !values.stdio)
      throw new Error("Use session --stdio");
    let command: unknown;
    switch (action) {
      case "session":
        break;
      case "status":
      case "snapshot":
        command = { op: action };
        break;
      case "screenshot":
        command = { op: "capture" };
        break;
      case "apps":
      case "wake":
      case "sleep":
        command = { op: action };
        break;
      case "home":
      case "back":
      case "recents":
        command = { op: "navigation", action };
        break;
      case "launch":
        command = { op: "launch", packageName: args[0] };
        break;
      case "text":
        if (!values["from-stdin"]) throw new Error("Use text --from-stdin");
        command = { op: "text", text: await readInput(4096) };
        break;
      case "tap":
        command = {
          op: "tap",
          scene: Number(values.scene),
          x: Number(args[0]),
          y: Number(args[1]),
        };
        break;
      case "swipe":
        command = {
          op: "swipe",
          scene: Number(values.scene),
          x: Number(args[0]),
          y: Number(args[1]),
          endX: Number(args[2]),
          endY: Number(args[3]),
          duration: Number(args[4]),
        };
        break;
      default:
        throw new Error("Unknown command; use --help");
    }
    if (action !== "session") parseCommand(command);
    const phone = store.select(values.phone);
    const connected = await RemoteSession.connect(
      store.identity,
      phone.grant,
      (s) => process.stderr.write(`${s}\n`),
      controller.signal,
      {
        open: (identity, grant, report, signal) =>
          openEncryptedSession(
            { origin: phone.origin },
            identity,
            grant,
            report,
            signal,
          ),
      },
    );
    session = connected.session;
    if (action === "session") {
      if (!values.stdio) throw new Error("Use session --stdio");
      await output({ type: "ready", state: connected.state });
      for await (const line of lines(process.stdin, 16384)) {
        controller.signal.throwIfAborted();
        if (!line.trim()) continue;
        let id: unknown;
        try {
          let request: Record<string, unknown>;
          try {
            request = JSON.parse(line);
          } catch {
            throw new Error("Invalid JSON request");
          }
          if (!request || typeof request !== "object" || Array.isArray(request))
            throw new Error("Invalid request");
          id = request.id;
          if (typeof id !== "string" || id.length < 1 || id.length > 80)
            throw new Error("Request id must be a 1–80 character string");
          const { id: _, ...operation } = request;
          const reply = await session.command(
            requireCapability(parseCommand(operation), connected.state),
          );
          await output({
            id,
            ok: reply.kind !== "result" || reply.code === 0,
            reply: serialize(reply),
          });
        } catch (error) {
          controller.signal.throwIfAborted();
          if (process.stdout.destroyed) throw error;
          await output({
            id: typeof id === "string" ? id : null,
            ok: false,
            error: error instanceof Error ? error.message : "Command failed",
          });
          if (!session.connected)
            throw new Error(
              "Session ended; reconnect and observe before further input",
            );
        }
      }
      controller.signal.throwIfAborted();
      return;
    }
    const reply = await session.command(
      requireCapability(parseCommand(command), connected.state),
    );
    if (action === "screenshot" && values.out && reply.kind === "image") {
      await privateArtifact(values.out, reply.jpeg);
      await output({
        kind: "image",
        path: path.resolve(values.out),
        scene: reply.scene,
        width: reply.width,
        height: reply.height,
      });
    } else await output(serialize(reply));
    if (reply.kind === "result" && reply.code !== 0) process.exitCode = 1;
  } finally {
    session?.close();
    clearTimeout(timeout);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
main().catch((error) => {
  // Teardown has finished. Bound stderr flushing too, including a blocked stdout write.
  setTimeout(() => process.exit(1), 1000).unref();
  process.stderr.write(
    process.argv.includes("--json")
      ? `${JSON.stringify({ ok: false, error: { code: "CLI_ERROR", message: error instanceof Error ? error.message : "YepControl failed" } })}\n`
      : `${error instanceof Error ? error.message : "YepControl failed"}\n`,
    () => process.exit(1),
  );
  process.exitCode = 1;
});
