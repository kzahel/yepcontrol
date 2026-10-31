/** Additive live-media boundary. Only negotiated, authenticated sessions may use it. */
export const MEDIA_MAX_RECORD = 1048576;
export const MEDIA_LEASE_MS = 20000;
export const MEDIA_RENEW_MS = 5000;
export const MEDIA_START_MS = 10000;
export const MEDIA_REASONS = [
  "none",
  "permission",
  "disabled",
  "busy",
  "unavailable",
  "disconnected",
  "timeout",
  "stopped",
  "interrupted",
] as const;
export type MediaReason = (typeof MEDIA_REASONS)[number];
export type MediaPhase = "off" | "starting" | "live";
export interface SensorState {
  available: boolean;
  allowed: boolean;
  permission: boolean;
  stream: number;
  phase: MediaPhase;
  reason: MediaReason;
}
export interface MediaState {
  v: 1;
  camera: SensorState & { front: boolean; rear: boolean };
  microphone: SensorState;
}
export function parseMediaState(value: unknown): MediaState {
  if (!value || typeof value !== "object") throw Error("Invalid media state");
  const state = value as MediaState;
  if (state.v !== 1) throw Error("Invalid media capability");
  for (const sensor of [state.camera, state.microphone]) {
    if (
      !sensor ||
      typeof sensor !== "object" ||
      [sensor.available, sensor.allowed, sensor.permission].some(
        (v) => typeof v !== "boolean",
      ) ||
      !Number.isInteger(sensor.stream) ||
      sensor.stream < 0 ||
      sensor.stream > 0x7fffffff ||
      !["off", "starting", "live"].includes(sensor.phase) ||
      !MEDIA_REASONS.includes(sensor.reason) ||
      (sensor.phase !== "off" &&
        (sensor.stream === 0 || sensor.reason !== "none"))
    )
      throw Error("Invalid sensor state");
  }
  if (
    typeof state.camera.front !== "boolean" ||
    typeof state.camera.rear !== "boolean"
  )
    throw Error("Invalid camera state");
  return state;
}
export interface MediaPacket {
  kind: "jpeg" | "h264" | "pcm" | "event";
  stream: number;
  sequence: number;
  timestamp: number;
  width: number;
  height: number;
  key: boolean;
  data: Uint8Array<ArrayBuffer>;
}
const kinds = ["jpeg", "h264", "pcm", "event"] as const;
export function isMediaRecord(data: Uint8Array) {
  return (
    data.length >= 4 &&
    data[0] === 65 &&
    data[1] === 82 &&
    data[2] === 77 &&
    data[3] === 49
  );
}
export function decodeMedia(data: Uint8Array<ArrayBuffer>): MediaPacket {
  if (
    !isMediaRecord(data) ||
    data.length < 34 ||
    data.length > MEDIA_MAX_RECORD ||
    data[6] ||
    data[7]
  )
    throw Error("Invalid media record");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const kind = kinds[(data[4] ?? 0) - 1];
  const stream = view.getUint32(8),
    sequence = view.getUint32(12),
    timestamp = Number(view.getBigUint64(16));
  const width = view.getUint32(24),
    height = view.getUint32(28),
    key = data[5] === 1;
  if (
    !kind ||
    !stream ||
    stream > 0x7fffffff ||
    !sequence ||
    !Number.isSafeInteger(timestamp) ||
    (data[5] !== 0 && data[5] !== 1) ||
    (key && kind !== "h264")
  )
    throw Error("Invalid media metadata");
  const payload = data.slice(32);
  if (kind === "pcm") {
    if (
      width !== 16000 ||
      height !== 1 ||
      payload.length > 6400 ||
      payload.length % 2
    )
      throw Error("Invalid PCM record");
  } else if (kind === "event") {
    if (
      width ||
      height ||
      payload.length !== 2 ||
      ![1, 2, 3].includes(payload[0] ?? 0) ||
      (payload[1] ?? 255) >= MEDIA_REASONS.length ||
      (payload[0] === 1 && payload[1] !== 0) ||
      (payload[0] === 3 && payload[1] === 0)
    )
      throw Error("Invalid media event");
  } else {
    if (
      !width ||
      !height ||
      width > 4096 ||
      height > 4096 ||
      width * height > 16777216
    )
      throw Error("Invalid media geometry");
    if (kind === "jpeg" && (payload[0] !== 255 || payload[1] !== 216))
      throw Error("Invalid camera JPEG");
    if (
      kind === "h264" &&
      (payload.length < 5 ||
        payload[0] ||
        payload[1] ||
        (payload[2] !== 1 && (payload[2] || payload[3] !== 1)))
    )
      throw Error("Invalid camera H264");
  }
  return {
    kind,
    stream,
    sequence,
    timestamp,
    width,
    height,
    key,
    data: payload,
  };
}
export function encodeMedia(packet: MediaPacket): Uint8Array<ArrayBuffer> {
  if (
    packet.data.length > MEDIA_MAX_RECORD - 32 ||
    !kinds.includes(packet.kind) ||
    ![
      packet.stream,
      packet.sequence,
      packet.timestamp,
      packet.width,
      packet.height,
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    packet.stream > 0x7fffffff ||
    packet.sequence > 0xffffffff ||
    packet.width > 0xffffffff ||
    packet.height > 0xffffffff ||
    typeof packet.key !== "boolean"
  )
    throw Error("Invalid media packet");
  const bytes = new Uint8Array(32 + packet.data.length),
    view = new DataView(bytes.buffer);
  bytes.set([
    65,
    82,
    77,
    49,
    kinds.indexOf(packet.kind) + 1,
    packet.key ? 1 : 0,
    0,
    0,
  ]);
  view.setUint32(8, packet.stream);
  view.setUint32(12, packet.sequence);
  view.setBigUint64(16, BigInt(packet.timestamp));
  view.setUint32(24, packet.width);
  view.setUint32(28, packet.height);
  bytes.set(packet.data, 32);
  decodeMedia(bytes);
  return bytes;
}
