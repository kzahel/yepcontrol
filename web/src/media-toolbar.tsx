import type { ControlState } from "@remote/protocol/control";
import type { SharingState } from "./media-receiver.js";

export function mediaReadiness(
  state: ControlState,
  sensor: "camera" | "microphone",
) {
  const ready = state.media?.[sensor];
  if (!ready)
    return "Update YepControl on the phone to use camera and microphone sharing.";
  if (!ready.available) return `This phone has no available ${sensor}.`;
  if (!ready.allowed)
    return `Enable Allow remote ${sensor} in YepControl on the phone.`;
  if (!ready.permission)
    return `Allow ${sensor} permission in the phone settings.`;
  return "";
}
function sharingLabel(sensor: string, state: SharingState) {
  const phase =
    state.phase === "starting"
      ? "starting…"
      : state.phase === "stopping"
        ? "stopping…"
        : state.phase;
  return `${sensor} ${phase}${state.message ? ` · ${state.message}` : ""}`;
}
export function MediaToolbar({
  source,
  select,
  switching,
  state,
  camera,
  microphone,
  facing,
  setFacing,
  smooth,
  setSmooth,
  smoothSupported,
  startCamera,
  stopCamera,
  listen,
  stopListening,
}: {
  source: "screen" | "camera";
  select: (source: "screen" | "camera") => void;
  switching: boolean;
  state: ControlState;
  camera: SharingState;
  microphone: SharingState;
  facing: "front" | "rear";
  setFacing: (facing: "front" | "rear") => void;
  smooth: boolean;
  setSmooth: (smooth: boolean) => void;
  smoothSupported: boolean;
  startCamera: () => void;
  stopCamera: () => void;
  listen: () => void;
  stopListening: () => void;
}) {
  const cameraHint = mediaReadiness(state, "camera");
  const micHint = mediaReadiness(state, "microphone");
  return (
    <div className="media-toolbar">
      <fieldset className="media-source" aria-label="View source">
        <button
          type="button"
          aria-pressed={source === "screen"}
          disabled={switching}
          onClick={() => select("screen")}
        >
          Screen
        </button>
        <button
          type="button"
          aria-pressed={source === "camera"}
          disabled={switching}
          onClick={() => select("camera")}
        >
          Camera
        </button>
      </fieldset>
      <button
        className="listen-button"
        type="button"
        aria-pressed={microphone.phase !== "off"}
        aria-busy={
          microphone.phase === "starting" || microphone.phase === "stopping"
        }
        disabled={
          microphone.phase === "stopping" ||
          (microphone.phase === "off" && !!micHint)
        }
        title={
          microphone.phase === "off"
            ? micHint || "Listen to the phone microphone"
            : "Stop the phone microphone"
        }
        onClick={microphone.phase === "off" ? listen : stopListening}
      >
        {microphone.phase === "off" ? "Listen" : "Stop listening"}
      </button>
      <p
        className="microphone-state"
        data-phase={microphone.phase}
        aria-live="polite"
      >
        {sharingLabel("Microphone", microphone)}
        {microphone.phase === "off" && !microphone.message && micHint
          ? ` · ${micHint}`
          : ""}
      </p>
      {source === "camera" && (
        <>
          <div className="camera-options">
            <label>
              Camera
              <select
                aria-label="Phone camera"
                value={facing}
                disabled={camera.phase !== "off" || switching}
                onChange={(event) =>
                  setFacing(event.target.value as "front" | "rear")
                }
              >
                <option value="rear" disabled={!state.media?.camera.rear}>
                  Rear
                </option>
                <option value="front" disabled={!state.media?.camera.front}>
                  Front
                </option>
              </select>
            </label>
            <label>
              View
              <select
                aria-label="Camera quality"
                value={smooth ? "smooth" : "still"}
                disabled={camera.phase !== "off" || switching}
                onChange={(event) => setSmooth(event.target.value === "smooth")}
              >
                <option value="smooth" disabled={!smoothSupported}>
                  Live video
                </option>
                <option value="still">Still frames</option>
              </select>
            </label>
            <button
              type="button"
              disabled={
                switching ||
                camera.phase === "stopping" ||
                (camera.phase === "off" && !!cameraHint)
              }
              aria-busy={
                camera.phase === "starting" || camera.phase === "stopping"
              }
              onClick={camera.phase === "off" ? startCamera : stopCamera}
            >
              {camera.phase === "off" ? "Start camera" : "Stop camera"}
            </button>
          </div>
          <p
            className="camera-state"
            data-phase={camera.phase}
            aria-live="polite"
          >
            {sharingLabel("Camera", camera)}
            {camera.phase === "off" && !camera.message && cameraHint
              ? ` · ${cameraHint}`
              : ""}
          </p>
        </>
      )}
    </div>
  );
}

/** Reserve the same control space while connecting, with no sensor authority. */
export function MediaPreviewToolbar() {
  return (
    <div className="media-toolbar">
      <fieldset className="media-source" aria-label="View source">
        <button type="button" disabled aria-pressed="true">
          Screen
        </button>
        <button type="button" disabled aria-pressed="false">
          Camera
        </button>
      </fieldset>
      <button type="button" className="listen-button" disabled>
        Listen
      </button>
      <p className="microphone-state">Connect to use camera and microphone.</p>
    </div>
  );
}
