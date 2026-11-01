import {
  type Command,
  type ControlState,
  decodeReply,
  encodeCommand,
  type Reply,
  type TouchBatch,
} from "@remote/protocol/control";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "../src/app-shell.js";
import type { RemoteSession } from "../src/control-session.js";
import { RemoteScreen } from "../src/remote-screen.js";
import type { SavedPhone } from "../src/store.js";
import { sensorFixture } from "./sensor-fixture.js";
import "../src/viewer.css";

const state: ControlState = {
  type: "state",
  v: 1,
  device: {
    manufacturer: "Google",
    model: "Pixel 9",
    name: "Test phone",
    android: "17",
    sdk: 37,
    app: "0.6.0",
  },
  accessibility: true,
  locked: true,
  width: 1080,
  height: 2400,
  scene: 1,
  video: { id: 0, phase: "off", reason: "none" },
  unlockAllowed: true,
  savedPin: true,
  unlockBlocked: false,
};
const params = new URLSearchParams(location.search);
for (const flag of [
  "locked",
  "savedPin",
  "unlockAllowed",
  "unlockBlocked",
  "accessibility",
] as const) {
  if (params.has(flag)) state[flag] = params.get(flag) === "true";
}
if (params.has("width")) state.width = Number(params.get("width"));
if (params.has("height")) state.height = Number(params.get("height"));
let nativeId = 0;
let nativePending: Promise<unknown> = Promise.resolve();
function nativeCommand(command: Command): Promise<Reply> {
  const work = nativePending.then(async () => {
    const response = await fetch("/native-control", {
      method: "POST",
      body: encodeCommand(++nativeId, command),
    });
    if (!response.ok) throw Error("Native fixture exchange failed");
    return decodeReply(new Uint8Array(await response.arrayBuffer()));
  });
  nativePending = work.catch(() => {});
  return work;
}
if (params.has("native")) {
  const initial = await nativeCommand({ op: "start" });
  if (initial.kind !== "state") throw Error("Missing native fixture state");
  Object.assign(state, initial.state);
}
const unlockOutcome = params.get("unlock") || "success";
let finishUnlock = () => {};
const source = document.createElement("canvas");
source.width = 108;
source.height = 240;
const paint = source.getContext("2d");
if (!paint) throw Error("Fixture canvas unavailable");
paint.fillStyle = "#294b3b";
paint.fillRect(0, 0, source.width, source.height);
paint.fillStyle = "#eff5ef";
paint.font = "12px sans-serif";
paint.fillText("Layout fixture", 12, 36);
const jpeg = new Uint8Array(
  await (await fetch(source.toDataURL("image/jpeg"))).arrayBuffer(),
);
let failNext = false;
const trace: string[] = [];
const unlocks: string[] = [];
const videos: number[] = [];
const touches: TouchBatch[] = [];
const cameraSource = document.createElement("canvas");
cameraSource.width = 320;
cameraSource.height = 240;
const cameraPaint = cameraSource.getContext("2d");
if (!cameraPaint) throw Error("No camera fixture context");
cameraPaint.fillStyle = "#c45c2c";
cameraPaint.fillRect(0, 0, 320, 240);
const cameraJpeg = new Uint8Array(
  await (await fetch(cameraSource.toDataURL("image/jpeg"))).arrayBuffer(),
);
const sensors = params.has("media")
  ? sensorFixture(state, cameraJpeg)
  : undefined;
window.layoutFixture = {
  unmount: () => rendered.unmount(),
  trace,
  unlocks,
  videos,
  touches,
  sensors: sensors?.evidence,
  ended: "",
  legacyVideo: () => {
    delete state.video;
  },
  finishUnlock: () => finishUnlock(),
  patch: (patch) => Object.assign(state, patch),
  failNext: () => {
    failNext = true;
  },
};
let connected = true;
const session = {
  path: "relay",
  get connected() {
    return connected;
  },
  startCamera: sensors?.startCamera,
  startMicrophone: sensors?.startMicrophone,
  close: () => {
    connected = false;
    sensors?.close();
  },
  async command(command: Command): Promise<Reply> {
    if (params.has("native")) return nativeCommand(command);
    if (!connected) throw Error("Session ended");
    trace.push(`${command.op}: locked=${state.locked}`);
    if (trace.length > 30) trace.shift();
    if (command.op === "touch") {
      touches.push(command.batch);
      if (touches.length > 32) touches.shift();
    }
    if (command.op === "status") {
      sensors?.status();
      return { id: 1, kind: "state", state: { ...state } };
    }
    if (failNext && command.op === "navigation") {
      failNext = false;
      throw Error(
        "This is a deliberately long connection message. The action was not retried. Reconnect to continue when the phone is available.",
      );
    }
    if (command.op === "unlockSaved" || command.op === "unlock") {
      unlocks.push(command.op);
      if (unlockOutcome === "deferred")
        await new Promise<void>((resolve) => {
          finishUnlock = resolve;
        });
      if (unlockOutcome === "unavailable" && command.op === "unlockSaved")
        return { id: 1, kind: "result", code: 4 };
      if (unlockOutcome === "failed") {
        state.unlockBlocked = true;
        state.savedPin = false;
        return { id: 1, kind: "result", code: 9 };
      }
      if (unlockOutcome === "lost") throw Error("Unlock reply lost");
      if (unlockOutcome === "disconnected") {
        connected = false;
        throw Error("Connection lost after possible PIN delivery");
      }
      state.locked = false;
    }
    if (command.op === "video") {
      videos.push(command.quality);
      state.video = command.quality
        ? { id: (state.video?.id || 0) + 1, phase: "consent", reason: "none" }
        : { id: state.video?.id || 0, phase: "off", reason: "stopped" };
    }
    if (command.op === "videoFrame") return { id: 1, kind: "result", code: 6 };
    if (command.op === "sleep") state.locked = true;
    if (command.op === "capture") {
      if (state.locked) return { id: 1, kind: "result", code: 3 };
      return {
        id: 1,
        kind: "image",
        scene: state.scene,
        width: state.width,
        height: state.height,
        jpeg,
      };
    }
    if (command.op === "apps")
      return {
        id: 1,
        kind: "apps",
        apps: [{ packageName: "test.fixture.app", name: "Fixture app" }],
      };
    return { id: 1, kind: "result", code: 0 };
  },
} as unknown as RemoteSession;
const root = document.getElementById("root");
if (!root) throw Error("Missing fixture root");
const phone: SavedPhone = {
  id: "a".repeat(64),
  pairedAt: 1,
  device: state.device,
  deviceAt: 1,
  history: [],
  grant: {
    id: "b".repeat(32),
    phone: "fixture",
    viewer: "fixture",
    expires: 1,
    mac: "fixture",
    phoneSignature: "fixture",
    viewerSignature: "fixture",
  },
};
const rendered = createRoot(root);
rendered.render(
  <StrictMode>
    <AppShell phones={[phone]} current={phone}>
      <main className="connected-viewer">
        <RemoteScreen
          phoneId={phone.id}
          session={session}
          initial={{ ...state }}
          disconnect={() => {}}
          onEnded={(message) => {
            window.layoutFixture.ended ||= message || "Connection ended";
          }}
        />
      </main>
    </AppShell>
  </StrictMode>,
);

declare global {
  interface Window {
    layoutFixture: {
      unmount: () => void;
      patch: (patch: Partial<ControlState>) => void;
      failNext: () => void;
      finishUnlock: () => void;
      trace: string[];
      unlocks: string[];
      videos: number[];
      touches: TouchBatch[];
      ended: string;
      legacyVideo: () => void;
      sensors: ReturnType<typeof sensorFixture>["evidence"] | undefined;
    };
  }
}
