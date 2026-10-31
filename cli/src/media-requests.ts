import { MediaCliError } from "./media-errors.js";

export type CaptureRequest =
  | {
      kind: "snapshot";
      out: string;
      facing: "front" | "rear";
      durationMs: 0;
      fps: 1;
    }
  | {
      kind: "frames";
      out: string;
      facing: "front" | "rear";
      durationMs: number;
      fps: number;
    }
  | { kind: "microphone"; out: string; durationMs: number };
export type AgentMediaRequest =
  | {
      op: "cameraSnapshot" | "cameraStart" | "microphoneStart";
      capture: CaptureRequest;
    }
  | {
      op: "mediaReceive";
      stream: number;
      after: number;
      waitMs: number;
      out?: string;
    }
  | { op: "mediaStop"; stream: number };
const invalid = () =>
  new MediaCliError(
    "MEDIA_INVALID_ARGUMENT",
    "Invalid media operation; use --help for bounds and output options.",
  );
export function duration(value: unknown) {
  if (typeof value !== "string") throw invalid();
  const match = /^([0-9]+(?:\.[0-9]{1,3})?)(ms|s)$/.exec(value);
  if (!match) throw invalid();
  const ms = Number(match[1]) * (match[2] === "s" ? 1000 : 1);
  if (!Number.isSafeInteger(ms) || ms < 100 || ms > 60000) throw invalid();
  return ms;
}
function output(value: unknown) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 4096 ||
    value === "-" ||
    value.includes("\0")
  )
    throw invalid();
  return value;
}
function cameraFacing(value: unknown) {
  if (value === undefined) return "rear";
  if (value !== "front" && value !== "rear") throw invalid();
  return value;
}
function frameRate(value: unknown) {
  const fps = value ?? 1;
  if (typeof fps !== "number" || !Number.isInteger(fps) || fps < 1 || fps > 5)
    throw invalid();
  return fps;
}
export function captureRequest(
  kind: "snapshot" | "frames" | "microphone",
  v: Record<string, unknown>,
): CaptureRequest {
  if (kind === "snapshot")
    return {
      kind,
      out: output(v.out),
      facing: cameraFacing(v.facing),
      fps: 1,
      durationMs: 0,
    };
  const durationMs = duration(v.duration);
  if (kind === "microphone") return { kind, out: output(v.out), durationMs };
  const fps = frameRate(v.fps);
  if (Math.ceil((durationMs * fps) / 1000) > 100)
    throw new MediaCliError(
      "MEDIA_LIMIT",
      "Choose at most 100 sampled frames (1–5 fps, up to 60 seconds).",
    );
  return {
    kind,
    out: output(v.outDir),
    durationMs,
    fps,
    facing: cameraFacing(v.facing),
  };
}
export function commandMediaRequest(
  action: string,
  args: string[],
  v: Record<string, unknown>,
) {
  if (action !== "camera" && action !== "microphone") return;
  if (args.length !== 1) throw invalid();
  const kind =
    action === "camera" && args[0] === "snapshot"
      ? "snapshot"
      : action === "camera" && args[0] === "frames"
        ? "frames"
        : action === "microphone" && args[0] === "record"
          ? "microphone"
          : undefined;
  if (!kind) throw invalid();
  if (kind === "frames" ? v.out !== undefined : v["out-dir"] !== undefined)
    throw invalid();
  if (kind === "snapshot" && (v.duration !== undefined || v.fps !== undefined))
    throw invalid();
  if (kind === "microphone" && (v.fps !== undefined || v.facing !== undefined))
    throw invalid();
  return captureRequest(kind, {
    out: v.out,
    outDir: v["out-dir"],
    duration: v.duration,
    facing: v.facing,
    fps: v.fps === undefined ? undefined : Number(v.fps),
  });
}
export function validateCapture(request: CaptureRequest) {
  output(request.out);
  if (request.kind === "snapshot") {
    cameraFacing(request.facing);
    if (request.durationMs !== 0 || request.fps !== 1) throw invalid();
    return;
  }
  if (
    !Number.isSafeInteger(request.durationMs) ||
    request.durationMs < 100 ||
    request.durationMs > 60000
  )
    throw invalid();
  if (request.kind === "frames") {
    cameraFacing(request.facing);
    frameRate(request.fps);
    if (Math.ceil((request.durationMs * request.fps) / 1000) > 100)
      throw new MediaCliError(
        "MEDIA_LIMIT",
        "Choose at most 100 sampled frames.",
      );
  }
}
export function agentMediaRequest(
  value: Record<string, unknown>,
): AgentMediaRequest | undefined {
  const fields: Record<string, string[]> = {
    cameraSnapshot: ["out", "facing"],
    cameraStart: ["outDir", "duration", "fps", "facing"],
    microphoneStart: ["out", "duration"],
    mediaReceive: ["stream", "after", "waitMs", "out"],
    mediaStop: ["stream"],
  };
  if (typeof value.op !== "string" || !fields[value.op]) return;
  const allowed = fields[value.op] ?? [];
  if (Object.keys(value).some((k) => k !== "op" && !allowed.includes(k)))
    throw invalid();
  if (
    value.op === "cameraSnapshot" ||
    value.op === "cameraStart" ||
    value.op === "microphoneStart"
  )
    return {
      op: value.op,
      capture: captureRequest(
        value.op === "cameraSnapshot"
          ? "snapshot"
          : value.op === "cameraStart"
            ? "frames"
            : "microphone",
        value,
      ),
    };
  const stream = value.stream;
  if (
    !Number.isInteger(stream) ||
    typeof stream !== "number" ||
    stream < (value.op === "mediaStop" ? 0 : 1) ||
    stream > 0x7fffffff
  )
    throw invalid();
  if (value.op === "mediaStop") return { op: "mediaStop", stream };
  const after = value.after ?? 0,
    waitMs = value.waitMs ?? 0;
  if (
    typeof after !== "number" ||
    !Number.isInteger(after) ||
    after < 0 ||
    after > 100 ||
    typeof waitMs !== "number" ||
    !Number.isInteger(waitMs) ||
    waitMs < 0 ||
    waitMs > 1000
  )
    throw invalid();
  return {
    op: "mediaReceive",
    stream,
    after,
    waitMs,
    ...(value.out === undefined ? {} : { out: output(value.out) }),
  };
}
