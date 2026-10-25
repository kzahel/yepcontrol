import { b64 } from "@remote/protocol";
import type { Command, ControlState, Reply } from "@remote/protocol/control";
import type { PhoneFeatures } from "@remote/protocol/features";
import { createRoot } from "react-dom/client";
import type { RemoteSession } from "../src/control-session.js";
import type { ViewerServices } from "../src/phone-page.js";
import { ViewerApp } from "../src/viewer-app.js";
import "../src/viewer.css";
const fixtureDevice = (name: string) => ({
  manufacturer: "Google",
  model: "Pixel 9",
  name,
  android: "17",
  sdk: 37,
  app: "0.8.0",
  connectionPreparation: 1 as const,
});

const models = (await (await fetch("/fixture-models")).json()) as Record<
  string,
  string
>;
const source = document.createElement("canvas");
source.width = 108;
source.height = 240;
const paint = source.getContext("2d");
if (!paint) throw Error("Missing canvas");
paint.fillStyle = "#294b3b";
paint.fillRect(0, 0, 108, 240);
const jpeg = new Uint8Array(
  await (await fetch(source.toDataURL("image/jpeg"))).arrayBuffer(),
);
window.phonesFixture = {
  fail: sessionStorage.getItem("fixture-fail") === "true",
  delay: sessionStorage.getItem("fixture-delay") === "true",
  controlDelay: sessionStorage.getItem("fixture-control-delay") === "true",
  calls: [],
  closed: 0,
  checks: 0,
  controls: 0,
  reused: 0,
  drop: () => {},
  finishCheck: () => {},
  finishControl: () => {},
  features: {
    type: "features",
    v: 1,
    screenViewing: "enabled",
    touchControl: "enabled",
    connectionRequests: "enabled",
    device: fixtureDevice("Fixture phone"),
  },
};
async function deferred(
  kind: "finishCheck" | "finishControl",
  signal?: AbortSignal,
) {
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Cancelled", "AbortError"));
    };
    window.phonesFixture[kind] = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}
const services: ViewerServices = {
  async prepare(identity, grant, report, signal) {
    const features = await services.check(identity, grant, report, signal);
    if (!features) throw Error("Missing features");
    let active = true;
    let end: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      end = resolve;
    });
    const session = {
      get connected() {
        return active;
      },
      closed,
      close() {
        active = false;
        end();
      },
      async send() {
        throw Error("Use fixture control adapter");
      },
      async read() {
        throw Error("Use fixture control adapter");
      },
    };
    signal.addEventListener("abort", () => session.close(), { once: true });
    return {
      features,
      session,
      expiresAt:
        Date.now() +
        Number(sessionStorage.getItem("fixture-preparation-ms") ?? 29000),
    };
  },
  async connect(identity, grant, _report, signal, prepared) {
    if (b64(identity.publicKey) !== grant.viewer)
      throw Error("Wrong browser identity");
    if (prepared) {
      if (!("connected" in prepared) || !prepared.connected)
        throw Error("Preparation was closed before promotion");
      window.phonesFixture.reused++;
    }
    window.phonesFixture.controls++;
    window.phonesFixture.calls.push(grant.id);
    if (window.phonesFixture.controlDelay)
      await deferred("finishControl", signal);
    if (window.phonesFixture.fail) throw Error("Fixture phone is unavailable");
    const state: ControlState = {
      type: "state",
      v: 1,
      device: fixtureDevice(models[grant.phone] ?? "Fixture phone"),
      accessibility: true,
      locked: false,
      width: 1080,
      height: 2400,
      scene: 1,
    };
    let active = true;
    const session = {
      get connected() {
        return active;
      },
      path: "relay",
      close() {
        if (active) window.phonesFixture.closed++;
        active = false;
        prepared?.close();
      },
      async command(command: Command): Promise<Reply> {
        if (!active) throw Error("Fixture session ended");
        if (command.op === "status") return { id: 1, kind: "state", state };
        if (command.op === "capture")
          return {
            id: 1,
            kind: "image",
            width: 1080,
            height: 2400,
            scene: 1,
            jpeg,
          };
        return { id: 1, kind: "result", code: 0 };
      },
    } as unknown as RemoteSession;
    window.phonesFixture.drop = () => session.close();
    signal.addEventListener("abort", () => session.close(), { once: true });
    return { session, state };
  },
  async check(identity, grant, _report, signal) {
    if (b64(identity.publicKey) !== grant.viewer)
      throw Error("Wrong browser identity");
    window.phonesFixture.checks++;
    window.phonesFixture.calls.push(grant.id);
    if (window.phonesFixture.delay) await deferred("finishCheck", signal);
    if (window.phonesFixture.fail) throw Error("Fixture phone is unavailable");
    const features = window.phonesFixture.features;
    return features
      ? {
          ...features,
          device: {
            ...features.device,
            name: models[grant.phone] ?? "Fixture phone",
          },
        }
      : undefined;
  },
};
const root = document.getElementById("root");
if (!root) throw Error("Missing root");
createRoot(root).render(<ViewerApp services={services} />);

declare global {
  interface Window {
    phonesFixture: {
      fail: boolean;
      delay: boolean;
      controlDelay: boolean;
      calls: string[];
      closed: number;
      checks: number;
      controls: number;
      reused: number;
      drop: () => void;
      finishCheck: () => void;
      finishControl: () => void;
      features: PhoneFeatures | undefined;
    };
  }
}
