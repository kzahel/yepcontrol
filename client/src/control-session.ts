import type { Identity } from "@remote/protocol";
import {
  type Command,
  decodeReply,
  encodeCommand,
} from "@remote/protocol/control";
import type { Grant } from "@remote/protocol/enrollment";
import type { openEncryptedSession } from "./relay.js";

export type Lane = Pick<
  Awaited<ReturnType<typeof openEncryptedSession>>,
  "close" | "send" | "read"
>;
export interface SessionAdapters {
  open: (
    identity: Identity,
    grant: Grant,
    report: (s: string) => void,
    signal: AbortSignal,
  ) => Promise<Lane>;
  direct?: (
    identity: Identity,
    grant: Grant,
    offer: (sdp: string) => Promise<string>,
    signal: AbortSignal,
  ) => Promise<Lane>;
}
class RecoveredAction extends Error {}
/** One command owner at a time. Path changes release held input; uncertain commands are never replayed. */
export class RemoteSession {
  private sequence = 0;
  private queued = 0;
  private active = true;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly abort = new AbortController();
  private lane: Lane;
  private detach: (() => void) | undefined;
  private upgradeTimer: ReturnType<typeof setTimeout> | undefined;
  get connected() {
    return this.active;
  }
  get path() {
    return this.lane === this.relay ? "relay" : "direct";
  }
  private constructor(
    private readonly relay: Lane,
    private readonly adapters: SessionAdapters,
  ) {
    this.lane = relay;
  }
  static async connect(
    identity: Identity,
    grant: Grant,
    report: (s: string) => void,
    signal: AbortSignal,
    adapters: SessionAdapters,
    prepared?: Lane,
  ) {
    if (signal.aborted) {
      prepared?.close();
      signal.throwIfAborted();
    }
    const session = new RemoteSession(
      prepared ?? (await adapters.open(identity, grant, report, signal)),
      adapters,
    );
    if (signal.aborted) {
      session.close();
      signal.throwIfAborted();
    }
    const stop = () => session.close();
    session.detach = () => signal.removeEventListener("abort", stop);
    signal.addEventListener("abort", stop, { once: true });
    try {
      const reply = await session.command({ op: "start" });
      if (reply.kind !== "state")
        throw new Error("Update the phone app to enable remote control");
      // Show the first useful screen before spending a bounded interval on a direct route.
      if (adapters.direct)
        session.upgradeTimer = setTimeout(() => {
          void session.upgrade(identity, grant);
        }, 1000);
      return { session, state: reply.state };
    } catch (error) {
      session.close();
      throw error;
    }
  }
  private async exchange(command: Command, lane = this.lane) {
    const id = ++this.sequence,
      encoded = encodeCommand(id, command);
    try {
      await lane.send(encoded);
    } finally {
      encoded.fill(0);
    }
    const bytes = await lane.read(15000);
    if (!bytes)
      throw new Error(
        "Phone did not respond. Reconnect; the action was not retried.",
      );
    const reply = decodeReply(bytes);
    if (reply.id !== id) throw new Error("Unexpected phone reply");
    return reply;
  }
  private async recover() {
    if (this.lane !== this.relay) this.lane.close();
    this.lane = this.relay;
    const reply = await this.exchange({ op: "start" });
    if (reply.kind !== "state") throw new Error("Relay recovery unavailable");
  }
  private upgrade(identity: Identity, grant: Grant) {
    if (!this.active) return Promise.resolve();
    const task = this.pending.then(async () => {
      if (!this.active || !this.adapters.direct) return;
      try {
        const direct = await this.adapters.direct(
          identity,
          grant,
          async (sdp) => {
            const response = await this.exchange(
              { op: "directOffer", sdp },
              this.relay,
            );
            if (response.kind !== "directAnswer")
              throw new Error("Direct connection unavailable");
            return response.sdp;
          },
          this.abort.signal,
        );
        if (!this.active) {
          direct.close();
          return;
        }
        this.lane = direct;
        const started = await this.exchange({ op: "start" });
        if (started.kind !== "state")
          throw new Error("Direct control unavailable");
      } catch {
        // The direct handshake may have replaced the native command owner. Start a fresh relay owner.
        if (this.active) await this.recover();
      }
    });
    this.pending = task.catch(() => {
      this.close();
    });
    return this.pending;
  }
  command(command: Command) {
    if (!this.active || this.queued >= 8)
      return Promise.reject(new Error("Phone is busy. Try again."));
    this.queued++;
    const task = this.pending.then(async () => {
      if (!this.active) throw new Error("Session ended");
      try {
        return await this.exchange(command);
      } catch (error) {
        if (this.path === "direct" && this.active) {
          await this.recover();
          throw new RecoveredAction(
            "Direct connection interrupted. Continued through the relay; the action was not retried.",
          );
        }
        throw error;
      }
    });
    this.pending = task.catch((error) => {
      if (!(error instanceof RecoveredAction)) this.close();
    });
    return task.finally(() => {
      this.queued--;
    });
  }
  close() {
    if (!this.active) return;
    this.active = false;
    this.detach?.();
    clearTimeout(this.upgradeTimer);
    this.abort.abort();
    if (this.lane !== this.relay) this.lane.close();
    this.relay.close();
  }
}
