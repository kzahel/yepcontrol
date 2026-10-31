import type { ControlState } from "@remote/protocol/control";
import { encodeMedia, type MediaPacket } from "@remote/protocol/media";
import { vi } from "vitest";

export interface NativeCommand {
  id: number;
  op: number;
  stream: number;
  format: number;
}
export function phoneLane(
  capable = true,
  hook?: (command: NativeCommand) => boolean,
) {
  const queue: (Uint8Array<ArrayBuffer> | Error)[] = [];
  let waiting:
    | ((value: Uint8Array<ArrayBuffer> | Error | undefined) => void)
    | undefined;
  let active = true,
    reads = 0,
    writes = 0,
    maxReads = 0,
    maxWrites = 0;
  let lostReply: number | undefined;
  const commands: NativeCommand[] = [];
  const streams = new Map<
    number,
    {
      kind: "jpeg" | "h264" | "pcm";
      sequence: number;
      phase: "starting" | "live";
    }
  >();
  const observed = new Map<number, ((command: NativeCommand) => void)[]>();
  const push = (value: Uint8Array<ArrayBuffer> | Error) => {
    if (waiting) waiting(value);
    else queue.push(value);
  };
  const reply = (id: number, kind = 2, payload = new Uint8Array([0])) => {
    const data = new Uint8Array(12 + payload.length),
      view = new DataView(data.buffer);
    data.set([65, 82, 80, 49, kind, 0, 0, 0]);
    view.setUint32(8, id);
    data.set(payload, 12);
    push(data);
  };
  const media = (
    stream: number,
    kind: MediaPacket["kind"],
    data: Uint8Array<ArrayBuffer>,
    sequence?: number,
  ) => {
    const entry = streams.get(stream);
    const seq = sequence ?? (entry?.sequence ?? 0) + 1;
    if (entry) {
      entry.sequence = seq;
      if (kind !== "event") entry.phase = "live";
    }
    const packet = {
      kind,
      stream,
      sequence: seq,
      timestamp: seq * 1000,
      width: kind === "event" ? 0 : kind === "pcm" ? 16000 : 320,
      height: kind === "event" ? 0 : kind === "pcm" ? 1 : 240,
      key: kind === "h264",
      data,
    };
    push(encodeMedia(packet));
  };
  const openStream = (stream: number, kind: "jpeg" | "h264" | "pcm") => {
    streams.set(stream, { kind, sequence: 0, phase: "starting" });
    media(stream, "event", new Uint8Array([1, 0]));
  };
  const state: ControlState = {
    type: "state",
    v: 1,
    accessibility: true,
    locked: false,
    width: 1080,
    height: 2400,
    scene: 1,
    device: {
      manufacturer: "Fixture",
      model: "Phone",
      name: "Phone",
      android: "15",
      sdk: 35,
      app: "0.10.0",
    },
    ...(capable
      ? {
          media: {
            v: 1,
            camera: {
              available: true,
              allowed: true,
              permission: true,
              front: true,
              rear: true,
              stream: 0,
              phase: "off",
              reason: "none",
            },
            microphone: {
              available: true,
              allowed: true,
              permission: true,
              stream: 0,
              phase: "off",
              reason: "none",
            },
          } as const,
        }
      : {}),
  };
  const close = vi.fn(() => {
    if (!active) return;
    active = false;
    streams.clear();
    waiting?.(new Error("Connection ended"));
  });
  return {
    commands,
    streams,
    state,
    close,
    reply,
    media,
    openStream,
    get sent() {
      return commands.map((c) => c.op);
    },
    get maxReads() {
      return maxReads;
    },
    get maxWrites() {
      return maxWrites;
    },
    loseReply(op: number) {
      lostReply = op;
    },
    fail(error = new Error("Transport failed")) {
      push(error);
    },
    untilCommand(op: number) {
      const found = [...commands].reverse().find((c) => c.op === op);
      if (found) return Promise.resolve(found);
      return new Promise<NativeCommand>((resolve) => {
        const list = observed.get(op) ?? [];
        list.push(resolve);
        observed.set(op, list);
      });
    },
    send: vi.fn(async (bytes: Uint8Array<ArrayBuffer>) => {
      if (!active) throw new Error("Connection ended");
      maxWrites = Math.max(maxWrites, ++writes);
      try {
        await Promise.resolve();
        const view = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        const command = {
          id: view.getUint32(8),
          op: bytes[4] ?? 0,
          stream: bytes.length >= 16 ? view.getUint32(12) : 0,
          format: bytes[17] ?? 0,
        };
        commands.push(command);
        for (const resolve of observed.get(command.op) ?? []) resolve(command);
        observed.delete(command.op);
        if (command.op === lostReply) {
          push(new Error("Reply lost after possible native delivery"));
          return;
        }
        if (hook?.(command)) return;
        if ([1, 2].includes(command.op)) {
          const report = structuredClone(state);
          if (report.media)
            for (const [sensor, formats] of [
              ["camera", ["jpeg", "h264"]],
              ["microphone", ["pcm"]],
            ] as const) {
              const running = [...streams].find(([, s]) =>
                formats.some((format) => format === s.kind),
              );
              if (running) {
                report.media[sensor].stream = running[0];
                report.media[sensor].phase = running[1].phase;
              }
            }
          reply(
            command.id,
            1,
            new TextEncoder().encode(JSON.stringify(report)),
          );
        } else if (command.op === 19)
          reply(command.id, 6, new TextEncoder().encode("v=0\r\nanswer"));
        else if ([24, 25].includes(command.op)) {
          reply(command.id);
          openStream(
            command.stream,
            command.op === 25 ? "pcm" : command.format === 1 ? "jpeg" : "h264",
          );
        } else if (command.op === 26) {
          reply(command.id);
          for (const [stream] of [...streams])
            if (!command.stream || stream === command.stream) {
              media(stream, "event", new Uint8Array([2, 7]));
              streams.delete(stream);
            }
        } else if (command.op === 27)
          reply(
            command.id,
            2,
            new Uint8Array([streams.has(command.stream) ? 0 : 4]),
          );
        else reply(command.id);
      } finally {
        writes--;
      }
    }),
    read: vi.fn(
      async (timeout = 30000): Promise<Uint8Array<ArrayBuffer> | undefined> => {
        if (!active) throw new Error("Connection ended");
        maxReads = Math.max(maxReads, ++reads);
        try {
          const next =
            queue.shift() ??
            (await new Promise<Uint8Array<ArrayBuffer> | Error | undefined>(
              (resolve) => {
                const timer = setTimeout(() => done(undefined), timeout);
                const done = (
                  value: Uint8Array<ArrayBuffer> | Error | undefined,
                ) => {
                  clearTimeout(timer);
                  waiting = undefined;
                  resolve(value);
                };
                waiting = done;
              },
            ));
          if (next instanceof Error) throw next;
          return next;
        } finally {
          reads--;
        }
      },
    ),
  };
}
