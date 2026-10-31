import {
  type CameraOptions,
  type RemoteMedia,
  RemoteSession,
} from "../../client/src/control-session.js";
import { acceptOffer, createPairing } from "../../client/src/pairing.js";
import { pairingApi } from "../../client/src/pairing-request.js";
import { openEncryptedSession } from "../../client/src/relay.js";
import type { Command } from "../../protocol/src/control.js";
import {
  encodeInvitation,
  type Grant,
  type Invitation,
} from "../../protocol/src/enrollment.js";
import { createIdentity } from "../../protocol/src/index.js";
import { openDirectLane } from "../../web/src/direct-lane.js";
import { VideoRenderer } from "../../web/src/video-renderer.js";

// Only aggregate evidence crosses Playwright. Keys and plaintext media stay in this isolated context.
const origin = location.origin;
const identity = await createIdentity();
let invitation: Invitation, grant: Grant, session: RemoteSession | undefined;
let relayLane: Awaited<ReturnType<typeof openEncryptedSession>> | undefined;
let directLane: Awaited<ReturnType<typeof openDirectLane>> | undefined;
const subscriptions = new Map<number, RemoteMedia>();
const paused = new Set<number>();
const ends: { stream: number; reason: string }[] = [];
const stats = {
  frames: {} as Record<number, number>,
  audio: {} as Record<
    number,
    { samples: number; nonzero: number; energy: number }
  >,
  dimensions: {} as Record<number, number[]>,
  errors: 0,
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function consume(stream: RemoteMedia) {
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const renderer = new VideoRenderer(canvas, (frame) => {
    stats.frames[stream.id] = (stats.frames[stream.id] ?? 0) + 1;
    stats.dimensions[stream.id] = [frame.width, frame.height];
  });
  try {
    while (stream.active) {
      while (paused.has(stream.id) && stream.active) await delay(30);
      const packet = await stream.read(1000);
      if (!packet) continue;
      if (packet.kind === "pcm") {
        const value = stats.audio[stream.id] ?? {
          samples: 0,
          nonzero: 0,
          energy: 0,
        };
        stats.audio[stream.id] = value;
        const bytes = new DataView(
          packet.data.buffer,
          packet.data.byteOffset,
          packet.data.byteLength,
        );
        for (let i = 0; i < bytes.byteLength; i += 2) {
          const n = bytes.getInt16(i, true);
          value.samples++;
          value.energy += n * n;
          if (n) value.nonzero++;
        }
      } else if (packet.kind === "jpeg") {
        const bitmap = await createImageBitmap(
          new Blob([packet.data], { type: "image/jpeg" }),
        );
        try {
          if (bitmap.width !== packet.width || bitmap.height !== packet.height)
            throw Error("Camera dimensions disagree");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          stats.frames[stream.id] = (stats.frames[stream.id] ?? 0) + 1;
          stats.dimensions[stream.id] = [bitmap.width, bitmap.height];
        } finally {
          bitmap.close();
        }
      } else if (packet.kind === "h264") {
        renderer.push({
          id: 1,
          kind: "video",
          epoch: stream.id,
          scene: 1,
          width: packet.width,
          height: packet.height,
          sourceWidth: packet.width,
          sourceHeight: packet.height,
          timestamp: packet.timestamp,
          key: packet.key,
          data: packet.data,
        });
      }
    }
  } catch {
    stats.errors++;
    await stream.stop().catch(() => {});
  } finally {
    renderer.close();
    canvas.remove();
  }
}

Object.assign(window, {
  stats,
  mediaProof: {
    async invite() {
      const time = await pairingApi(origin).time();
      invitation = await createPairing(
        origin,
        identity,
        "Encrypted media acceptance",
        time.expires,
      );
      return { id: invitation.id, uri: encodeInvitation(invitation) };
    },
    async pair() {
      const api = pairingApi(origin);
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const offered = await api.request(invitation.id);
        if (offered.state === "offered" && offered.grant) {
          grant = (
            await acceptOffer(
              identity,
              invitation,
              offered.grant,
              offered.device ?? "",
              Date.now(),
            )
          ).grant;
          const accepted = await api.request(invitation.id, "complete", {
            viewerSignature: grant.viewerSignature,
          });
          if (accepted.state !== "paired")
            throw Error("Pairing did not complete");
          return { paired: true };
        }
        await delay(600);
      }
      throw Error("Native pairing timeout");
    },
    async connect(direct: boolean) {
      session?.close();
      await Promise.all(
        [...subscriptions.values()].map((stream) => stream.closed),
      );
      subscriptions.clear();
      paused.clear();
      ends.length = 0;
      stats.frames = {};
      stats.audio = {};
      stats.dimensions = {};
      stats.errors = 0;
      const result = await RemoteSession.connect(
        identity,
        grant,
        () => {},
        new AbortController().signal,
        {
          open: async (i, g, report, signal) => {
            relayLane = await openEncryptedSession(
              { origin },
              i,
              g,
              report,
              signal,
            );
            return relayLane;
          },
          ...(direct
            ? {
                direct: async (i, g, offer, signal) => {
                  directLane = await openDirectLane(i, g, offer, signal);
                  return directLane;
                },
              }
            : {}),
        },
      );
      session = result.session;
      return { media: result.state.media, path: session.path };
    },
    async start(sensor: "camera" | "microphone", options: CameraOptions = {}) {
      if (!session) throw Error("Connect first");
      const stream =
        sensor === "camera"
          ? await session.startCamera(options)
          : await session.startMicrophone();
      subscriptions.set(stream.id, stream);
      void stream.closed.then((reason) => {
        ends.push({ stream: stream.id, reason });
      });
      void consume(stream);
      return { stream: stream.id, path: session.path };
    },
    async cancelCamera() {
      if (!session) throw Error("Connect first");
      const cancel = new AbortController();
      const stream = await session.startCamera({
        format: "jpeg",
        signal: cancel.signal,
      });
      cancel.abort();
      const reason = await stream.closed;
      return { reason, stream: stream.id, connected: session.connected };
    },
    async stop(id: number) {
      await subscriptions.get(id)?.stop();
    },
    pause(id: number) {
      paused.add(id);
    },
    async command(command: Command) {
      const reply = await session?.command(command);
      return reply?.kind === "state"
        ? { kind: reply.kind, state: reply.state }
        : reply?.kind === "image"
          ? { kind: "image", width: reply.width, height: reply.height }
          : reply;
    },
    status() {
      return {
        path: session?.path,
        connected: session?.connected,
        ends: [...ends],
        streams: [...subscriptions].map(([id, stream]) => ({
          id,
          phase: stream.phase,
          reason: stream.reason,
        })),
      };
    },
    dropDirect() {
      directLane?.close();
    },
    dropRelay() {
      relayLane?.close();
    },
    close() {
      session?.close();
    },
    async revoked() {
      return (
        (await fetch(`${origin}/api/pair/${invitation.id}`)).status === 410
      );
    },
  },
});
