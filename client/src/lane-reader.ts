import { decodeReply, type Reply } from "@remote/protocol/control";
import {
  decodeMedia,
  isMediaRecord,
  type MediaPacket,
} from "@remote/protocol/media";
import type { Lane } from "./control-session.js";

/** A lane has exactly one read/decrypt owner, even when command replies and media interleave. */
export class LaneReader {
  private active = true;
  private readonly replies = new Map<
    number,
    {
      resolve: (reply: Reply) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly lane: Lane,
    private readonly media: (packet: MediaPacket) => void,
    private readonly failed: (error: Error) => void,
  ) {
    void this.pump();
  }
  wait(id: number): Promise<Reply> {
    if (!this.active) return Promise.reject(new Error("Connection ended"));
    if (this.replies.has(id) || this.replies.size >= 8)
      return Promise.reject(new Error("Too many pending replies"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.replies.delete(id);
        reject(new Error("Phone did not respond; the action was not retried"));
      }, 15000);
      this.replies.set(id, { resolve, reject, timer });
    });
  }
  private async pump() {
    try {
      while (this.active) {
        const bytes = await this.lane.read(30000);
        if (!this.active) return;
        if (!bytes) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          continue;
        }
        if (isMediaRecord(bytes)) {
          this.media(decodeMedia(bytes));
          continue;
        }
        const reply = decodeReply(bytes),
          pending = this.replies.get(reply.id);
        if (!pending) throw new Error("Unexpected phone reply");
        this.replies.delete(reply.id);
        clearTimeout(pending.timer);
        pending.resolve(reply);
      }
    } catch (error) {
      if (this.active) {
        this.close(
          error instanceof Error ? error : new Error("Connection ended"),
        );
        this.failed(
          error instanceof Error ? error : new Error("Connection ended"),
        );
      }
    }
  }
  close(error = new Error("Session ended")) {
    if (!this.active) return;
    this.active = false;
    for (const pending of this.replies.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.replies.clear();
  }
}
