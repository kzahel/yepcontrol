import {
  applicationDefault,
  deleteApp,
  initializeApp,
} from "firebase-admin/app";
import { getMessaging, type Message } from "firebase-admin/messaging";

import type { RelayState } from "./state.js";
import { takeWake, type WakeAllowance } from "./wake-allowance.js";

export type Wake = {
  requestId: string;
  expires: number;
  pairingId?: string;
  generation?: string;
};
export type Delivery = "accepted" | "invalid_target" | "unavailable";
export type Sender = (fid: string, wake: Wake) => Promise<Delivery>;
export function validFid(value: unknown): value is string {
  return typeof value === "string" && /^[cdef][A-Za-z0-9_-]{21}$/.test(value);
}
export function wakeMessage(fid: string, wake: Wake): Message {
  return {
    fid,
    data: {
      intent: "connect-v1",
      requestId: wake.requestId,
      expires: String(wake.expires),
      ...(wake.pairingId ? { pairingId: wake.pairingId } : {}),
      ...(wake.generation ? { generation: wake.generation } : {}),
    },
    android: { priority: "high", ttl: 60000, collapseKey: "connect-v1" },
  };
}
export function firebaseSender(projectId: string) {
  const app = initializeApp(
    { credential: applicationDefault(), projectId },
    "android-remote",
  );
  return {
    send: firebaseDelivery((message) => getMessaging(app).send(message)),
    close: () => deleteApp(app),
  };
}
export function firebaseDelivery(
  send: (message: Message) => Promise<string>,
): Sender {
  return async (fid, wake) => {
    try {
      await send(wakeMessage(fid, wake));
      return "accepted";
    } catch (error) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      return code === "messaging/registration-token-not-registered" ||
        code === "messaging/invalid-registration-token"
        ? "invalid_target"
        : "unavailable";
    }
  };
}

/** Delivery addresses are private metadata, never part of public pairing replies. */
export class PushRegistry {
  private targets: Record<string, { fid: string; generation?: string }> =
    Object.create(null);
  private readonly cooldown = new Map<string, WakeAllowance>();
  private readonly state: RelayState;
  private window = 0;
  private sends = 0;
  constructor(
    state: RelayState,
    private readonly send?: Sender,
    private readonly now = Date.now,
    private readonly cooldownMs = 30000,
    private readonly wakeBurst: 1 | 2 = 2,
  ) {
    this.state = state;
    this.targets = state.targets();
  }
  register(id: string, fid: string, generation?: string) {
    if (!validFid(fid)) throw new Error("Invalid registration");
    if (generation !== undefined && !/^[0-9a-f]{32}$/.test(generation))
      throw new Error("Invalid generation");
    if (
      this.targets[id]?.fid === fid &&
      this.targets[id]?.generation === generation
    )
      return;
    const target = { fid, ...(generation ? { generation } : {}) };
    this.state.putTarget(id, target);
    this.targets[id] = target;
  }
  remove(id: string) {
    this.state.removeTarget(id);
    delete this.targets[id];
  }
  retryAfterMs(id: string): number {
    return takeWake(
      this.now(),
      this.cooldown.get(id),
      this.cooldownMs,
      this.wakeBurst,
    ).retryAfterMs;
  }
  async wake(
    id: string,
    request: Wake,
  ): Promise<Delivery | "coalesced" | "unregistered"> {
    const target = this.targets[id];
    const fid = target?.fid;
    if (!fid || !this.send) return "unregistered";
    const now = this.now();
    if (request.expires * 1000 <= now) return "unavailable";
    const allowance = takeWake(
      now,
      this.cooldown.get(id),
      this.cooldownMs,
      this.wakeBurst,
    );
    if (allowance.retryAfterMs > 0) return "coalesced";
    if (this.window <= now) {
      this.window = now + 60000;
      this.sends = 0;
    }
    if (this.sends >= 100) return "unavailable";
    this.sends++;
    this.cooldown.set(id, allowance.state);
    for (const [key, value] of this.cooldown)
      if (value.at + this.wakeBurst * this.cooldownMs <= now)
        this.cooldown.delete(key);
    let result: Delivery;
    try {
      result = await this.send(fid, {
        ...request,
        ...(target?.generation
          ? { pairingId: id, generation: target.generation }
          : {}),
      });
    } catch {
      result = "unavailable";
    }
    // A concurrent registration refresh must survive an old-target failure.
    if (result === "invalid_target" && this.targets[id] === target)
      this.remove(id);
    return result;
  }
}
