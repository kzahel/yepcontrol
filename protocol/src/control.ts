import {
  parseSnapshot,
  type UiSnapshot,
  validObservation,
} from "./accessibility.js";
import { type DeviceInfo, parseDevice } from "./device.js";

/** Commands travel only inside an authenticated application record. Integers are big-endian. */
export type TouchBatch = {
  scene: number;
  gesture: number;
  sequence: number;
  duration: number;
  contacts: { id: number; held: boolean; path: { x: number; y: number }[] }[];
};
export type Command =
  | {
      op:
        | "start"
        | "status"
        | "capture"
        | "wake"
        | "apps"
        | "videoFrame"
        | "videoKey"
        | "snapshot";
    }
  | { op: "tap"; scene: number; x: number; y: number }
  | {
      op: "swipe";
      scene: number;
      x: number;
      y: number;
      endX: number;
      endY: number;
      duration: number;
    }
  | { op: "navigation"; action: "back" | "home" | "recents" }
  | { op: "text"; text: string }
  | { op: "launch"; packageName: string }
  | { op: "touch"; batch: TouchBatch }
  | { op: "release" | "unlockSaved" | "sleep" }
  | { op: "unlock"; pin: string }
  | { op: "video"; quality: 0 | 1 | 2 | 3 }
  | { op: "directOffer"; sdp: string }
  | { op: "nodeClick"; observation: string; node: number }
  | {
      op: "nodeScroll";
      observation: string;
      node: number;
      direction: "forward" | "backward";
    }
  | { op: "nodeText"; observation: string; node: number; text: string };
const operations = [
  "start",
  "status",
  "capture",
  "tap",
  "swipe",
  "navigation",
  "text",
  "launch",
  "wake",
  "apps",
  "touch",
  "release",
  "unlock",
  "unlockSaved",
  "sleep",
  "video",
  "videoFrame",
  "videoKey",
  "directOffer",
  "snapshot",
  "nodeClick",
  "nodeScroll",
  "nodeText",
] as const;
export const MAX_COMMAND = 32784;
export function encodeCommand(
  id: number,
  command: Command,
): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(id) || id < 1 || id > 0xffffffff)
    throw new Error("Invalid command ID");
  let values: number[] = [];
  let tail = new Uint8Array();
  if (command.op === "touch") tail = encodeTouch(command.batch);
  switch (command.op) {
    case "nodeClick":
    case "nodeScroll":
    case "nodeText": {
      if (
        !validObservation(command.observation) ||
        !Number.isInteger(command.node) ||
        command.node < 0 ||
        command.node >= 128
      )
        throw new Error("Invalid UI reference");
      const text =
        command.op === "nodeText"
          ? new TextEncoder().encode(command.text)
          : new Uint8Array();
      if (
        text.length > 4096 ||
        (command.op === "nodeScroll" &&
          !["forward", "backward"].includes(command.direction))
      )
        throw new Error("Invalid UI action");
      tail = new Uint8Array(
        20 + (command.op === "nodeScroll" ? 1 : text.length),
      );
      for (let i = 0; i < 16; i++)
        tail[i] = Number.parseInt(
          command.observation.slice(i * 2, i * 2 + 2),
          16,
        );
      new DataView(tail.buffer).setUint32(16, command.node);
      if (command.op === "nodeScroll")
        tail[20] = command.direction === "forward" ? 1 : 2;
      else tail.set(text, 20);
      break;
    }
    case "tap":
      values = [command.scene, command.x, command.y];
      break;
    case "swipe":
      values = [
        command.scene,
        command.x,
        command.y,
        command.endX,
        command.endY,
        command.duration,
      ];
      break;
    case "navigation":
      tail = new Uint8Array([
        ["back", "home", "recents"].indexOf(command.action) + 1,
      ]);
      break;
    case "directOffer":
      tail = new TextEncoder().encode(command.sdp);
      if (!command.sdp.startsWith("v=0\r\n") || tail.length > 32768)
        throw new Error("Invalid direct offer");
      break;
    case "video":
      if (![0, 1, 2, 3].includes(command.quality))
        throw new Error("Invalid video quality");
      tail = new Uint8Array([command.quality]);
      break;
    case "unlock":
      if (!/^[0-9]{4,16}$/.test(command.pin))
        throw new Error("Use a 4–16 digit PIN");
      tail = new TextEncoder().encode(command.pin);
      break;
    case "text":
      tail = new TextEncoder().encode(command.text);
      if (tail.length > 4096) throw new Error("Text too long");
      break;
    case "launch":
      if (
        !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(
          command.packageName,
        ) ||
        command.packageName.length > 256
      )
        throw new Error("Invalid app");
      tail = new TextEncoder().encode(command.packageName);
      break;
  }
  if (
    values.some((v) => !Number.isInteger(v) || v < 0 || v > 0x7fffffff) ||
    ("scene" in command && command.scene === 0) ||
    (command.op === "swipe" &&
      (command.duration < 40 || command.duration > 2000))
  )
    throw new Error("Invalid gesture");
  const out = new Uint8Array(12 + values.length * 4 + tail.length);
  out.set([65, 82, 67, 49, operations.indexOf(command.op) + 1, 0, 0, 0]);
  const view = new DataView(out.buffer);
  view.setUint32(8, id);
  values.forEach((v, i) => {
    view.setUint32(12 + i * 4, v);
  });
  out.set(tail, 12 + values.length * 4);
  return out;
}
export type VideoState = {
  id: number;
  phase: "off" | "consent" | "starting" | "active";
  reason:
    | "none"
    | "stopped"
    | "canceled"
    | "timeout"
    | "interrupted"
    | "locked"
    | "unavailable"
    | "disconnected"
    | "permission";
};
export type ControlState = {
  type: "state";
  v: 1;
  accessibility: boolean;
  locked: boolean;
  width: number;
  height: number;
  scene: number;
  device: DeviceInfo;
  videoActive?: boolean;
  // Additive capability for internal-beta hosts; stills remain usable before an app update.
  video?: VideoState;
  unlockSupported?: boolean;
  unlockAllowed?: boolean;
  savedPin?: boolean;
  unlockBlocked?: boolean;
  /** The phone is showing settings that accept only local input. */
  localSettings?: boolean;
  /** Snapshot and observation-bound node actions. Absent on existing public hosts. */
  a11y?: 1;
};
export type AppEntry = { name: string; packageName: string };
export type Reply = { id: number } & (
  | { kind: "snapshot"; snapshot: UiSnapshot }
  | { kind: "apps"; apps: AppEntry[] }
  | { kind: "directAnswer"; sdp: string }
  | { kind: "state"; state: ControlState }
  | { kind: "result"; code: number }
  | {
      kind: "video";
      epoch: number;
      scene: number;
      width: number;
      height: number;
      sourceWidth: number;
      sourceHeight: number;
      key: boolean;
      timestamp: number;
      data: Uint8Array<ArrayBuffer>;
    }
  | {
      kind: "image";
      scene: number;
      width: number;
      height: number;
      jpeg: Uint8Array<ArrayBuffer>;
    }
);
export function decodeReply(data: Uint8Array<ArrayBuffer>): Reply {
  if (
    data.length < 12 ||
    data.length > 1048576 ||
    String.fromCharCode(...data.slice(0, 4)) !== "ARP1" ||
    data.slice(5, 8).some(Boolean)
  )
    throw new Error("Invalid control reply");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const id = view.getUint32(8);
  if (!id) throw new Error("Invalid reply ID");
  switch (data[4]) {
    case 1: {
      if (data.length > 2048) throw new Error("Invalid state");
      const s: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(data.slice(12)),
      );
      if (!s || typeof s !== "object") throw new Error("Invalid state");
      const state = s as ControlState;
      if (
        state.type !== "state" ||
        state.v !== 1 ||
        typeof state.accessibility !== "boolean" ||
        typeof state.locked !== "boolean" ||
        [state.width, state.height, state.scene].some(
          (n) => !Number.isInteger(n) || n < 0 || n > 0x7fffffff,
        ) ||
        state.width > 16384 ||
        state.height > 16384
      )
        throw new Error("Invalid state");
      if (state.a11y !== undefined && state.a11y !== 1)
        throw new Error("Invalid UI capability");
      state.device = parseDevice(state.device);
      if (state.video !== undefined) {
        const video = state.video;
        if (
          !video ||
          typeof video !== "object" ||
          !Number.isInteger(video.id) ||
          video.id < 0 ||
          video.id > 0x7fffffff ||
          !["off", "consent", "starting", "active"].includes(video.phase) ||
          ![
            "none",
            "stopped",
            "canceled",
            "timeout",
            "interrupted",
            "locked",
            "unavailable",
            "disconnected",
            "permission",
          ].includes(video.reason) ||
          (video.phase !== "off" && (video.id === 0 || video.reason !== "none"))
        )
          throw new Error("Invalid video state");
      }
      for (const field of [
        "videoActive",
        "unlockSupported",
        "unlockAllowed",
        "savedPin",
        "unlockBlocked",
        "localSettings",
      ] as const) {
        if (state[field] !== undefined && typeof state[field] !== "boolean")
          throw new Error("Invalid unlock state");
      }
      return { id, kind: "state", state };
    }
    case 7: {
      if (data.length > 524288) throw new Error("UI snapshot too large");
      return {
        id,
        kind: "snapshot",
        snapshot: parseSnapshot(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(data.slice(12)),
          ),
        ),
      };
    }
    case 2:
      if (data.length !== 13 || data[12] === undefined || data[12] > 9)
        throw new Error("Invalid result");
      return { id, kind: "result", code: data[12] };
    case 3: {
      if (data.length < 28) throw new Error("Invalid image");
      const scene = view.getUint32(12),
        width = view.getUint32(16),
        height = view.getUint32(20);
      if (
        !scene ||
        scene > 0x7fffffff ||
        !width ||
        !height ||
        width > 16384 ||
        height > 16384 ||
        data[24] !== 255 ||
        data[25] !== 216
      )
        throw new Error("Invalid image");
      return { id, kind: "image", scene, width, height, jpeg: data.slice(24) };
    }
    case 6: {
      if (data.length > 32780) throw new Error("Invalid direct answer");
      const sdp = new TextDecoder("utf-8", { fatal: true }).decode(
        data.slice(12),
      );
      if (!sdp.startsWith("v=0\r\n")) throw new Error("Invalid direct answer");
      return { id, kind: "directAnswer", sdp };
    }
    case 5: {
      if (data.length < 52 || data.length > 524288)
        throw new Error("Invalid video frame");
      const epoch = view.getUint32(12),
        scene = view.getUint32(16),
        width = view.getUint32(20),
        height = view.getUint32(24),
        sourceWidth = view.getUint32(28),
        sourceHeight = view.getUint32(32),
        flags = view.getUint32(36),
        timestamp = Number(view.getBigUint64(40));
      if (
        !epoch ||
        !scene ||
        [width, height, sourceWidth, sourceHeight].some(
          (n) => !n || n > 16384,
        ) ||
        flags > 1 ||
        !Number.isSafeInteger(timestamp)
      )
        throw new Error("Invalid video geometry");
      return {
        id,
        kind: "video",
        epoch,
        scene,
        width,
        height,
        sourceWidth,
        sourceHeight,
        key: flags === 1,
        timestamp,
        data: data.slice(48),
      };
    }
    case 4: {
      if (data.length > 131072) throw new Error("Invalid app list");
      const apps: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(data.slice(12)),
      );
      if (
        !Array.isArray(apps) ||
        apps.length > 200 ||
        apps.some(
          (a) =>
            !a ||
            typeof a !== "object" ||
            typeof a.name !== "string" ||
            a.name.length > 100 ||
            typeof a.packageName !== "string" ||
            a.packageName.length > 256 ||
            !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(
              a.packageName,
            ),
        )
      )
        throw new Error("Invalid app list");
      return { id, kind: "apps", apps };
    }
    default:
      throw new Error("Unknown control reply");
  }
}
export function resultMessage(code: number): string {
  return (
    [
      "Done",
      "Enable screen access on the phone",
      "Screen changed. Try again",
      "Phone is locked",
      "This action is unavailable",
      "Screen is protected or capture was interrupted",
      "Phone is busy. Try again",
      "Action was interrupted; it was not retried",
      "Session ended",
      "Unlock needs local recovery. No retry was made. Unlock the phone locally before trying again.",
    ][code] ?? "Action failed"
  );
}

function encodeTouch(batch: TouchBatch): Uint8Array<ArrayBuffer> {
  const int = (n: number, min: number, max: number) =>
    Number.isInteger(n) && n >= min && n <= max;
  if (
    !int(batch.scene, 1, 0x7fffffff) ||
    !int(batch.gesture, 1, 0x7fffffff) ||
    !int(batch.sequence, 0, 1000000) ||
    !int(batch.duration, 16, 100) ||
    batch.contacts.length < 1 ||
    batch.contacts.length > 10
  )
    throw new Error("Invalid touch batch");
  const ids = new Set<number>();
  for (const c of batch.contacts) {
    if (
      !int(c.id, 0, 1000000) ||
      ids.has(c.id) ||
      typeof c.held !== "boolean" ||
      c.path.length < 1 ||
      c.path.length > 24 ||
      c.path.some(
        (p) =>
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          p.x < 0 ||
          p.y < 0 ||
          p.x >= 16384 ||
          p.y >= 16384,
      )
    )
      throw new Error("Invalid contact");
    ids.add(c.id);
  }
  const out = new Uint8Array(
      16 + batch.contacts.reduce((n, c) => n + 8 + c.path.length * 8, 0),
    ),
    v = new DataView(out.buffer);
  v.setUint32(0, batch.scene);
  v.setUint32(4, batch.gesture);
  v.setUint32(8, batch.sequence);
  v.setUint16(12, batch.duration);
  v.setUint8(14, batch.contacts.length);
  let offset = 16;
  for (const c of batch.contacts) {
    v.setUint32(offset, c.id);
    v.setUint8(offset + 4, c.held ? 1 : 0);
    v.setUint8(offset + 5, c.path.length);
    offset += 8;
    for (const p of c.path) {
      v.setFloat32(offset, p.x);
      v.setFloat32(offset + 4, p.y);
      offset += 8;
    }
  }
  return out;
}
