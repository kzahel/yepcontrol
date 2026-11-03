#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { RemoteSession } from "@remote/client/control-session";
import { openEncryptedSession } from "@remote/client/relay";
import { encode } from "uqr";
import { AgentSession } from "./agent-session.js";
import { parseCommand, requireCapability } from "./commands.js";
import { MediaCliError } from "./media-errors.js";
import { MediaJobs } from "./media-jobs.js";
import { commandMediaRequest } from "./media-requests.js";
import { serializeReply, output as writeOutput } from "./output.js";
import { pair } from "./pair.js";
import { privateArtifact, Store } from "./store.js";

const help = `YepControl CLI (Node 24+)
  pair [--name NAME] [--from-stdin | --code-file PATH] [--origin HTTPS_ORIGIN]
  phones
  status | snapshot [--max-nodes N --max-depth N --timeout-ms N] | screenshot [--out PATH] | apps | wake | sleep
  query (--selector JSON | --from-stdin) [--max-nodes N --max-depth N --max-matches N --timeout-ms N]
  tap X Y --scene N
  swipe X Y END_X END_Y DURATION_MS --scene N
  text --from-stdin
  home | back | recents | launch PACKAGE
  camera snapshot --out photo.jpg [--facing rear|front]
  camera frames --duration 10s --fps 1 --out-dir frames/ [--facing rear|front]
  microphone record --duration 10s --out audio.wav
  session --stdio      JSON lines: {"id":"1","op":"capture"}
Options: --phone ID, --json (fatal errors are JSON on stderr), --help
State: YEPCONTROL_HOME or ~/.config/yepcontrol (owner-only).
Pairing links and text use stdin, never command arguments. Screenshots return JPEG
base64 in session replies, or an owner-only --out artifact in screenshot mode.
Media captures use private files (no overwrite/symlinks), up to 60s, 1–5 camera fps,
100 artifacts and 64 MiB per job. Durations accept ms or s. Camera frames sample
for up to the chosen duration. The output parent directory must already exist.
Agent media ops: cameraSnapshot, cameraStart, microphoneStart, mediaReceive,
mediaStop. Starts require bounded duration and output; receive can save a recent
microphone second with out. Polling is independent of capture. Keep stdin open;
EOF/cancellation stops media. New media replies contain metadata, never bytes.
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
function selectorJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw Error("Invalid UI selector JSON");
  }
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
        "out-dir": { type: "string" },
        duration: { type: "string" },
        fps: { type: "string" },
        facing: { type: "string" },
        scene: { type: "string" },
        stdio: { type: "boolean" },
        selector: { type: "string" },
        "max-nodes": { type: "string" },
        "max-depth": { type: "string" },
        "max-matches": { type: "string" },
        "timeout-ms": { type: "string" },
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
  const capture = commandMediaRequest(action, args, values);
  const controller = new AbortController();
  const output = (value: unknown) => writeOutput(value, controller.signal);
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (error: Error = new Error("Canceled")) => {
    controller.abort(error);
    process.stdin.destroy();
    shutdownTimer ??= setTimeout(() => process.exit(1), 3000);
    shutdownTimer.unref();
  };
  const cancel = () => stop();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const timeout = setTimeout(cancel, action === "pair" ? 310000 : 3600000);
  timeout.unref();
  let session: RemoteSession | undefined;
  let jobs: MediaJobs | undefined;
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
    if (
      action === "query" &&
      values.selector !== undefined &&
      values["from-stdin"]
    )
      throw Error("Choose one selector input mode");
    let command: unknown;
    switch (action) {
      case "camera":
      case "microphone":
        break;
      case "session":
        break;
      case "status":
        command = { op: action };
        break;
      case "snapshot":
      case "query":
        command = {
          op: action,
          ...(action === "query"
            ? {
                selector: selectorJson(
                  values["from-stdin"]
                    ? await readInput(4096)
                    : (values.selector ?? "null"),
                ),
              }
            : {}),
          ...(values["max-nodes"] !== undefined
            ? { maxNodes: Number(values["max-nodes"]) }
            : {}),
          ...(values["max-depth"] !== undefined
            ? { maxDepth: Number(values["max-depth"]) }
            : {}),
          ...(values["timeout-ms"] !== undefined
            ? { timeoutMs: Number(values["timeout-ms"]) }
            : {}),
          ...(values["max-matches"] !== undefined
            ? { maxMatches: Number(values["max-matches"]) }
            : {}),
        };
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
    if (action !== "session" && !capture) parseCommand(command);
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
    jobs = new MediaJobs(session, connected.state, controller.signal, stop);
    if (capture) {
      const job = await jobs.start(capture);
      const result = await job.done;
      await output({ ok: result.state === "complete", ...result });
      if (result.state !== "complete") process.exitCode = 1;
      return;
    }
    if (action === "session") {
      await output({ type: "ready", state: connected.state });
      const agent = new AgentSession(
        session,
        connected.state,
        jobs,
        controller.signal,
        output,
        stop,
      );
      for await (const line of lines(process.stdin, 16384))
        await agent.accept(line);
      await agent.finish();
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
    } else await output(serializeReply(reply));
    if (reply.kind === "result" && reply.code !== 0) process.exitCode = 1;
  } finally {
    if (jobs?.active) {
      shutdownTimer ??= setTimeout(() => process.exit(1), 3000);
      shutdownTimer.unref();
    }
    const closing = jobs?.close();
    session?.close();
    await closing;
    clearTimeout(timeout);
    clearTimeout(shutdownTimer);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
main().catch((error) => {
  // Teardown has finished. Bound stderr flushing too, including a blocked stdout write.
  setTimeout(() => process.exit(1), 1000).unref();
  process.stderr.write(
    process.argv.includes("--json")
      ? `${JSON.stringify({ ok: false, error: { code: error instanceof MediaCliError ? error.code : "CLI_ERROR", message: error instanceof Error ? error.message : "YepControl failed" } })}\n`
      : `${error instanceof Error ? error.message : "YepControl failed"}\n`,
    () => process.exit(1),
  );
  process.exitCode = 1;
});
