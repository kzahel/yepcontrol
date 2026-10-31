import path from "node:path";
import {
  MediaError,
  type RemoteMedia,
  type RemoteSession,
} from "@remote/client/control-session";
import type { ControlState } from "@remote/protocol/control";
import type { MediaPacket } from "@remote/protocol/media";
import {
  MEDIA_ARTIFACT_LIMIT,
  MEDIA_BYTE_LIMIT,
  MediaFile,
  mediaDirectory,
  removeEmptyMediaDirectory,
  wavHeader,
} from "./media-artifacts.js";
import { MediaCliError, mediaFailure } from "./media-errors.js";
import { type CaptureRequest, validateCapture } from "./media-requests.js";

export interface MediaArtifact {
  kind: "camera" | "microphone";
  format: "jpeg" | "wav";
  path: string;
  bytes: number;
  timestampUs: number;
  index?: number;
  width?: number;
  height?: number;
  samples?: number;
  sampleRate?: 16000;
  channels?: 1;
  durationMs?: number;
  startSample?: number;
}
export interface MediaJobState {
  kind: "media-job";
  stream: number;
  sensor: "camera" | "microphone";
  state:
    | "starting"
    | "recording"
    | "stopping"
    | "complete"
    | "stopped"
    | "canceled"
    | "error";
  requestedDurationMs: number;
  bytes: number;
  samples: number;
  count: number;
  output: string;
  stopConfirmed: boolean;
  latest?: MediaArtifact;
  manifest?: string;
  error?: { code: string; message: string };
}
type RingChunk = { data: Uint8Array<ArrayBuffer>; timestampUs: number };
const reasonMessage: Record<string, string> = {
  stopped: "Sharing was stopped on the phone.",
  permission: "Access was blocked on the phone.",
  disabled: "Remote sharing was turned off on the phone.",
  busy: "The phone sensor is in use.",
  unavailable: "The phone sensor is unavailable.",
  timeout: "The phone stopped sending media.",
  disconnected: "The connection ended.",
  interrupted: "Media capture was interrupted.",
};

/** A bounded job drains continuously, independently of agent polling and stdout. */
export class MediaJob {
  readonly abort = new AbortController();
  readonly signal: AbortSignal;
  readonly started: Promise<MediaJob>;
  readonly done: Promise<MediaJobState>;
  readonly sensor: "camera" | "microphone";
  private accepted!: (job: MediaJob) => void;
  private refused!: (error: MediaCliError) => void;
  private stream: RemoteMedia | undefined;
  private state: MediaJobState["state"] = "starting";
  private failure: MediaCliError | undefined;
  private file: MediaFile | undefined;
  private directory: string | undefined;
  private shot: MediaPacket | undefined;
  private frames: MediaArtifact[] = [];
  private manifest: string | undefined;
  private latest: MediaArtifact | undefined;
  private ring: RingChunk[] = [];
  private ringBytes = 0;
  private dataBytes = 0;
  private budgetBytes = 0;
  private artifactCount = 0;
  private firstTimestamp = 0;
  private targetComplete = false;
  private explicitStop = false;
  private timedOut = false;
  private stopConfirmed = false;
  constructor(
    readonly request: CaptureRequest,
    private readonly session: RemoteSession,
    parent: AbortSignal,
    private readonly onStarted: (job: MediaJob) => void,
    private readonly onTimeout: (error: MediaCliError) => void,
  ) {
    this.sensor = request.kind === "microphone" ? "microphone" : "camera";
    this.signal = AbortSignal.any([parent, this.abort.signal]);
    this.started = new Promise((resolve, reject) => {
      this.accepted = resolve;
      this.refused = reject;
    });
    this.done = this.run();
  }
  get id() {
    return this.stream?.id ?? 0;
  }
  get active() {
    return ["starting", "recording", "stopping"].includes(this.state);
  }
  snapshot(): MediaJobState {
    return {
      kind: "media-job",
      stream: this.id,
      sensor: this.sensor,
      state: this.state,
      requestedDurationMs: this.request.durationMs,
      bytes: this.dataBytes,
      samples: this.sensor === "microphone" ? this.dataBytes / 2 : 0,
      count: this.frames.length,
      output: path.resolve(this.request.out),
      stopConfirmed: this.stopConfirmed,
      ...(this.latest ? { latest: this.latest } : {}),
      ...(this.manifest ? { manifest: this.manifest } : {}),
      ...(this.failure
        ? { error: { code: this.failure.code, message: this.failure.message } }
        : {}),
    };
  }
  private spend(bytes: number, artifact = false, metadata = false) {
    const reserve = this.request.kind === "frames" && !metadata ? 131072 : 0;
    if (
      this.budgetBytes + bytes > MEDIA_BYTE_LIMIT - reserve ||
      (artifact && this.artifactCount >= MEDIA_ARTIFACT_LIMIT)
    )
      throw new MediaCliError(
        "MEDIA_LIMIT",
        "Media output reached its 64 MiB or 100-artifact limit.",
      );
    this.budgetBytes += bytes;
    if (artifact) this.artifactCount++;
  }
  private async run(): Promise<MediaJobState> {
    const timer = setTimeout(() => {
      this.timedOut = true;
      this.abort.abort();
      this.onTimeout(
        new MediaCliError(
          "MEDIA_TIMEOUT",
          "Media capture timed out; its connection was closed.",
        ),
      );
    }, this.request.durationMs + 20000);
    try {
      if (this.request.kind === "frames")
        this.directory = await mediaDirectory(this.request.out);
      else {
        this.file = await MediaFile.create(this.request.out);
        this.spend(this.request.kind === "microphone" ? 44 : 0, true);
        if (this.request.kind === "microphone")
          await this.file.append(wavHeader(0));
      }
      this.signal.throwIfAborted();
      this.stream =
        this.request.kind === "microphone"
          ? await this.session.startMicrophone({ signal: this.signal })
          : await this.session.startCamera({
              facing: this.request.facing,
              format: "jpeg",
              fps: this.request.fps,
              signal: this.signal,
            });
      this.onStarted(this);
      this.accepted(this);
      await this.collect();
      if (!this.targetComplete && !this.signal.aborted) {
        const reason =
          this.stream.reason === "none" ? "interrupted" : this.stream.reason;
        this.failure = mediaFailure(
          new MediaError(
            reason,
            reasonMessage[reason] ?? "Media capture ended.",
          ),
        );
      }
    } catch (error) {
      this.failure = this.signal.aborted
        ? new MediaCliError(
            this.timedOut ? "MEDIA_TIMEOUT" : "MEDIA_CANCELED",
            this.timedOut
              ? "Media capture timed out."
              : "Media capture was canceled.",
          )
        : mediaFailure(error);
    } finally {
      if (
        this.signal.aborted &&
        !this.targetComplete &&
        !this.explicitStop &&
        !this.failure
      )
        this.failure = new MediaCliError(
          this.timedOut ? "MEDIA_TIMEOUT" : "MEDIA_CANCELED",
          this.timedOut
            ? "Media capture timed out."
            : "Media capture was canceled.",
        );
      this.state = "stopping";
      try {
        await this.stream?.stop();
        this.stopConfirmed = this.stream
          ? this.stream.reason !== "disconnected"
          : this.session.connected;
      } catch (error) {
        this.failure = mediaFailure(error);
      }
      if (this.id && !this.stopConfirmed && !this.failure)
        this.failure = new MediaCliError(
          "MEDIA_STOP_UNCONFIRMED",
          "Native Stop was not confirmed. The connection was closed.",
        );
      try {
        await this.finishArtifacts();
      } catch (error) {
        this.failure ??= mediaFailure(error);
      }
      try {
        await this.file?.dispose();
      } catch (error) {
        this.failure ??= mediaFailure(error);
      }
      clearTimeout(timer);
      if (this.timedOut)
        this.failure = new MediaCliError(
          "MEDIA_TIMEOUT",
          "Media capture timed out; its connection was closed.",
        );
      this.shot = undefined;
      if (this.failure?.code === "MEDIA_CANCELED" && this.explicitStop)
        this.failure = undefined;
      this.state = this.failure
        ? this.failure.code === "MEDIA_CANCELED"
          ? "canceled"
          : "error"
        : this.targetComplete
          ? "complete"
          : this.explicitStop
            ? "stopped"
            : "canceled";
      if (!this.id)
        this.refused(
          this.failure ??
            new MediaCliError("MEDIA_CANCELED", "Media capture was canceled."),
        );
    }
    return this.snapshot();
  }
  private async collect() {
    const stream = this.stream;
    if (!stream) throw Error("Missing media subscription");
    let firstReceived = 0,
      lastReceived = Date.now();
    const targetBytes =
      this.request.kind === "microphone" ? this.request.durationMs * 32 : 0;
    while (stream.active && !this.signal.aborted && !this.targetComplete) {
      const remaining =
        this.request.kind === "frames" && firstReceived
          ? firstReceived + this.request.durationMs - Date.now()
          : 1000;
      if (remaining <= 0) {
        this.targetComplete = this.frames.length > 0;
        break;
      }
      const packet = await stream.read(Math.max(1, Math.min(1000, remaining)));
      if (this.signal.aborted) break;
      if (!packet) {
        if (Date.now() - lastReceived > 10000)
          throw new MediaCliError(
            "MEDIA_TIMEOUT",
            "The phone stopped sending useful media.",
          );
        continue;
      }
      lastReceived = Date.now();
      if (!firstReceived) {
        firstReceived = lastReceived;
        this.firstTimestamp = packet.timestamp;
      }
      this.state = "recording";
      if (this.request.kind === "snapshot") {
        if (packet.kind !== "jpeg") throw Error("Unexpected camera format");
        this.spend(packet.data.length);
        this.shot = packet;
        this.dataBytes = packet.data.length;
        this.targetComplete = true;
      } else if (this.request.kind === "frames") {
        if (packet.kind !== "jpeg") throw Error("Unexpected camera format");
        if (lastReceived - firstReceived >= this.request.durationMs) {
          this.targetComplete = this.frames.length > 0;
          break;
        }
        this.spend(packet.data.length, true);
        const index = this.frames.length + 1;
        const file = await MediaFile.create(
          path.join(
            this.directory ?? "",
            `frame-${String(index).padStart(4, "0")}.jpg`,
          ),
        );
        try {
          await file.append(packet.data);
          await file.commit();
          const artifact: MediaArtifact = {
            kind: "camera",
            format: "jpeg",
            path: file.file,
            index,
            width: packet.width,
            height: packet.height,
            bytes: packet.data.length,
            timestampUs: packet.timestamp,
          };
          this.frames.push(artifact);
          this.latest = artifact;
          this.dataBytes += packet.data.length;
        } finally {
          await file.dispose();
        }
        if (
          this.frames.length >=
          Math.ceil((this.request.durationMs * this.request.fps) / 1000)
        )
          this.targetComplete = true;
      } else {
        if (packet.kind !== "pcm") throw Error("Unexpected microphone format");
        const bytes = packet.data.slice(
          0,
          Math.min(packet.data.length, targetBytes - this.dataBytes),
        );
        this.spend(bytes.length);
        await this.file?.append(bytes);
        this.dataBytes += bytes.length;
        this.ring.push({ data: bytes, timestampUs: packet.timestamp });
        this.ringBytes += bytes.length;
        while (this.ring.length > 64 || this.ringBytes > 32000) {
          const first = this.ring[0];
          if (!first) break;
          const excess = this.ringBytes - 32000;
          if (this.ring.length > 64 || excess >= first.data.length) {
            this.ring.shift();
            this.ringBytes -= first.data.length;
          } else {
            first.data = first.data.slice(excess);
            first.timestampUs += Math.round(((excess / 2) * 1000000) / 16000);
            this.ringBytes -= excess;
          }
        }
        this.targetComplete = this.dataBytes >= targetBytes;
      }
    }
  }
  private async finishArtifacts() {
    if (this.request.kind === "snapshot" && this.shot && this.file) {
      await this.file.append(this.shot.data);
      await this.file.commit();
      this.latest = {
        kind: "camera",
        format: "jpeg",
        path: this.file.file,
        index: 1,
        width: this.shot.width,
        height: this.shot.height,
        bytes: this.shot.data.length,
        timestampUs: this.shot.timestamp,
      };
      this.frames.push(this.latest);
    } else if (
      this.request.kind === "microphone" &&
      this.dataBytes &&
      this.file
    ) {
      await this.file.header(wavHeader(this.dataBytes));
      await this.file.commit();
      this.latest = {
        kind: "microphone",
        format: "wav",
        path: this.file.file,
        bytes: this.dataBytes + 44,
        timestampUs: this.firstTimestamp,
        samples: this.dataBytes / 2,
        sampleRate: 16000,
        channels: 1,
        durationMs: this.dataBytes / 32,
        startSample: 0,
      };
    } else if (this.request.kind === "frames" && this.directory) {
      if (!this.frames.length) {
        await removeEmptyMediaDirectory(this.directory);
        return;
      }
      const meta = Buffer.from(
        JSON.stringify(
          {
            v: 1,
            source: "camera",
            facing: this.request.facing,
            requestedFps: this.request.fps,
            requestedDurationMs: this.request.durationMs,
            partial: !this.targetComplete,
            frames: this.frames,
            error: this.failure
              ? { code: this.failure.code, message: this.failure.message }
              : null,
          },
          null,
          2,
        ),
      );
      this.spend(meta.length, false, true);
      const file = await MediaFile.create(
        path.join(this.directory, "capture.json"),
      );
      try {
        await file.append(meta);
        await file.commit();
        this.manifest = file.file;
      } finally {
        await file.dispose();
      }
    }
  }
  stop(explicit = true) {
    if (!this.active) return this.done;
    this.explicitStop = explicit;
    this.abort.abort();
    return this.done;
  }
  async receive(after: number, waitMs: number, out?: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (waitMs && this.active)
        await Promise.race([
          this.done,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, waitMs);
          }),
        ]);
    } finally {
      clearTimeout(timer);
    }
    if (after > this.frames.length)
      throw new MediaCliError(
        "MEDIA_INVALID_ARGUMENT",
        "The frame cursor is beyond the received frames.",
      );
    let artifact: MediaArtifact | undefined;
    if (out !== undefined) {
      if (this.sensor !== "microphone")
        throw new MediaCliError(
          "MEDIA_INVALID_ARGUMENT",
          "Camera receive returns existing frame paths; --out is for a microphone sample.",
        );
      const first = this.ring[0];
      if (!first || !this.ringBytes)
        throw new MediaCliError(
          "MEDIA_NOT_READY",
          "No microphone samples are available yet.",
        );
      const bytes = Buffer.concat(
        this.ring.map((chunk) => Buffer.from(chunk.data)),
        this.ringBytes,
      );
      const timestampUs = first.timestampUs,
        startSample = this.dataBytes / 2 - bytes.length / 2;
      this.spend(bytes.length + 44, true);
      const file = await MediaFile.create(out);
      try {
        await file.append(wavHeader(bytes.length));
        await file.append(bytes);
        await file.commit();
      } finally {
        await file.dispose();
      }
      artifact = {
        kind: "microphone",
        format: "wav",
        path: file.file,
        bytes: bytes.length + 44,
        timestampUs,
        samples: bytes.length / 2,
        sampleRate: 16000,
        channels: 1,
        durationMs: bytes.length / 32,
        startSample,
      };
    }
    const frames = this.frames.slice(after, after + 8);
    return {
      job: this.snapshot(),
      frames,
      nextAfter: frames.at(-1)?.index ?? after,
      ...(artifact ? { artifact } : {}),
    };
  }
}

export class MediaJobs {
  private pending = new Set<MediaJob>();
  private history = new Map<number, MediaJob>();
  private paths = new Map<string, "file" | "directory">();
  private closed = false;
  get active() {
    return this.pending.size > 0;
  }
  constructor(
    private readonly session: RemoteSession,
    private readonly initial: ControlState,
    private readonly signal: AbortSignal,
    private readonly failed?: (error: MediaCliError) => void,
  ) {}
  private reserve(value: string, directory = false) {
    const target = path.resolve(value);
    for (const [existing, kind] of this.paths) {
      if (
        existing === target ||
        (kind === "directory" && target.startsWith(existing + path.sep)) ||
        (directory && existing.startsWith(target + path.sep))
      )
        throw new MediaCliError(
          "MEDIA_OUTPUT_EXISTS",
          "That output path is already reserved by another capture.",
        );
    }
    this.paths.set(target, directory ? "directory" : "file");
    return () => this.paths.delete(target);
  }
  async start(request: CaptureRequest) {
    validateCapture(request);
    if (this.closed || this.signal.aborted)
      throw new MediaCliError("MEDIA_CANCELED", "The media owner has closed.");
    if (!this.initial.media)
      throw new MediaCliError(
        "MEDIA_UNSUPPORTED",
        "Update YepControl on the phone to use camera and microphone capture.",
      );
    const sensor = request.kind === "microphone" ? "microphone" : "camera";
    if ([...this.pending].some((job) => job.sensor === sensor && job.active))
      throw new MediaCliError(
        "MEDIA_BUSY",
        `A ${sensor} capture is already active.`,
      );
    const release = this.reserve(request.out, request.kind === "frames");
    const job = new MediaJob(
      request,
      this.session,
      this.signal,
      (started) => {
        this.history.set(started.id, started);
        this.prune();
      },
      (error) => {
        this.session.close();
        this.failed?.(error);
      },
    );
    this.pending.add(job);
    void job.done.finally(() => {
      this.pending.delete(job);
      release();
      this.prune();
    });
    return job.started;
  }
  private prune() {
    for (const [id, job] of this.history) {
      if (this.history.size <= 16) break;
      if (!job.active) this.history.delete(id);
    }
  }
  async receive(stream: number, after: number, waitMs: number, out?: string) {
    const job = this.history.get(stream);
    if (!job)
      throw new MediaCliError(
        "MEDIA_NOT_FOUND",
        "That media job is not retained in this session.",
      );
    const release = out === undefined ? undefined : this.reserve(out);
    try {
      return await job.receive(after, waitMs, out);
    } finally {
      release?.();
    }
  }
  async stop(stream = 0) {
    const jobs = stream
      ? [this.history.get(stream)].filter((job): job is MediaJob => !!job)
      : [...this.pending];
    const results = await Promise.all(jobs.map((job) => job.stop()));
    return {
      stopped: results.every((result) => result.stopConfirmed),
      jobs: results,
    };
  }
  close() {
    this.closed = true;
    return Promise.all([...this.pending].map((job) => job.stop(false)));
  }
}
