import type { RemoteSession } from "@remote/client/control-session";
import type { ControlState } from "@remote/protocol/control";
import { parseCommand, requireCapability } from "./commands.js";
import { MediaCliError, mediaFailure } from "./media-errors.js";
import type { MediaJobs } from "./media-jobs.js";
import { agentMediaRequest } from "./media-requests.js";
import { serializeReply } from "./output.js";

/** Ordinary actions remain ordered; local receive/Stop can bypass a pending ordinary reply. */
export class AgentSession {
  private ordinary: Promise<void> = Promise.resolve();
  private writer: Promise<void> = Promise.resolve();
  private tasks = new Set<Promise<void>>();
  private queued = 0;
  private priority = 0;
  private mediaGeneration = 0;
  private failure: Error | undefined;
  constructor(
    private readonly session: RemoteSession,
    private readonly state: ControlState,
    private readonly jobs: MediaJobs,
    private readonly signal: AbortSignal,
    private readonly output: (value: unknown) => Promise<void>,
    private readonly failed: (error: Error) => void,
  ) {}
  private send(value: unknown) {
    const task = this.writer
      .then(() => this.output(value))
      .catch((error) => {
        this.failure =
          error instanceof Error ? error : Error("Agent output failed");
        this.failed(this.failure);
        throw this.failure;
      });
    this.writer = task.catch(() => {});
    return task;
  }
  private error(id: unknown, error: unknown) {
    const code = error instanceof MediaCliError ? error.code : "CLI_ERROR";
    return this.send({
      id: typeof id === "string" ? id : null,
      ok: false,
      error: error instanceof Error ? error.message : "Command failed",
      errorCode: code,
    });
  }
  async accept(line: string) {
    this.signal.throwIfAborted();
    if (this.failure) throw this.failure;
    if (!line.trim()) return;
    let id: unknown;
    let operation: Record<string, unknown>;
    let media: ReturnType<typeof agentMediaRequest>;
    try {
      let request: Record<string, unknown>;
      try {
        request = JSON.parse(line);
      } catch {
        throw Error("Invalid JSON request");
      }
      if (!request || typeof request !== "object" || Array.isArray(request))
        throw Error("Invalid request");
      id = request.id;
      if (typeof id !== "string" || id.length < 1 || id.length > 80)
        throw Error("Request id must be a 1–80 character string");
      const { id: _, ...rest } = request;
      operation = rest;
      media = agentMediaRequest(operation);
      if (!media) parseCommand(operation);
    } catch (error) {
      await this.error(id, error);
      return;
    }
    const priority = media?.op === "mediaStop" || media?.op === "mediaReceive";
    if (priority ? this.priority >= 4 : this.queued >= 8) {
      await this.error(
        id,
        new MediaCliError("MEDIA_BUSY", "The agent request queue is full."),
      );
      return;
    }
    // A stop-all also cancels earlier starts waiting behind ordinary work.
    // Later explicit starts belong to a new generation and remain allowed.
    if (media?.op === "mediaStop" && media.stream === 0) this.mediaGeneration++;
    const mediaGeneration = this.mediaGeneration;
    if (priority) this.priority++;
    else this.queued++;
    const task = (priority ? Promise.resolve() : this.ordinary).then(
      async () => {
        this.signal.throwIfAborted();
        try {
          let reply: unknown,
            ok = true;
          if (
            media?.op === "cameraStart" ||
            media?.op === "microphoneStart" ||
            media?.op === "cameraSnapshot"
          ) {
            if (mediaGeneration !== this.mediaGeneration)
              throw new MediaCliError(
                "MEDIA_CANCELED",
                "Media start was canceled by Stop.",
              );
            const job = await this.jobs.start(media.capture);
            const state =
              media.op === "cameraSnapshot" ? await job.done : job.snapshot();
            ok = state.state !== "error" && state.state !== "canceled";
            reply = state;
          } else if (media?.op === "mediaReceive")
            reply = {
              kind: "media",
              ...(await this.jobs.receive(
                media.stream,
                media.after,
                media.waitMs,
                media.out,
              )),
            };
          else if (media?.op === "mediaStop") {
            const stopped = await this.jobs.stop(media.stream);
            reply = { kind: "media-stop", ...stopped };
            ok = stopped.stopped;
          } else {
            const result = await this.session.command(
              requireCapability(parseCommand(operation), this.state),
            );
            reply = serializeReply(result);
            ok = result.kind !== "result" || result.code === 0;
          }
          await this.send({ id, ok, reply });
        } catch (error) {
          this.signal.throwIfAborted();
          if (this.failure) throw this.failure;
          await this.error(
            id,
            error instanceof MediaCliError
              ? error
              : media
                ? mediaFailure(error)
                : error,
          );
          if (!this.session.connected)
            throw Error(
              "Session ended; reconnect and observe before further input",
            );
        }
      },
    );
    const tracked = task
      .catch((error) => {
        this.failure =
          error instanceof Error ? error : Error("Agent session failed");
        this.failed(this.failure);
      })
      .finally(() => {
        this.tasks.delete(tracked);
        if (priority) this.priority--;
        else this.queued--;
      });
    this.tasks.add(tracked);
    if (!priority) this.ordinary = tracked;
  }
  async finish() {
    // EOF cancels active and not-yet-started media, while already-written ordinary requests drain.
    const closing = this.jobs.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.tasks, closing]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error("Agent shutdown timed out; actions were not retried."),
              ),
            30000,
          );
        }),
      ]);
      if (this.failure) throw this.failure;
    } catch (error) {
      const failure =
        error instanceof Error ? error : Error("Agent shutdown failed");
      this.failed(failure);
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  }
}
