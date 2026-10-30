import {
  type AppEntry,
  type Command,
  type ControlState,
  resultMessage,
} from "@remote/protocol/control";
import { useEffect, useRef, useState } from "react";
import type { RemoteSession } from "./control-session.js";
import { RemoteControls } from "./remote-controls.js";
import { SmoothView, type SmoothViewState } from "./smooth-view.js";
import { TouchInput } from "./touch-input.js";
import { usePhoneUnlock } from "./use-phone-unlock.js";
import { useViewerFullscreen } from "./use-viewer-fullscreen.js";
import { VideoDecodeError, VideoRenderer } from "./video-renderer.js";
import { ViewerHeading } from "./viewer-heading.js";
import { ViewerWorkspace } from "./viewer-workspace.js";

/** Media and pointer coordinates stay in refs; React owns only status and controls. */
export function RemoteScreen({
  phoneId,
  session,
  initial,
  disconnect,
  name,
  notice,
  onContact,
  onEnded,
  aspect,
}: {
  phoneId: string;
  session: RemoteSession;
  initial: ControlState;
  disconnect: () => void;
  name?: string;
  notice?: string;
  onContact?: (state: ControlState) => void;
  onEnded?: (message?: string) => void;
  aspect?: number;
}) {
  const callbacks = useRef({
    onContact,
    onEnded,
    unlockMessage: (): string => "",
  });
  const canvas = useRef<HTMLCanvasElement>(null);
  const typingDialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<
    { scene: number; width: number; height: number } | undefined
  >(undefined);
  const touch = useRef<TouchInput | undefined>(undefined);
  const fullscreen = useViewerFullscreen(() => touch.current?.release());
  const [state, setState] = useState(initial);
  const [message, setMessage] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [text, setText] = useState("");
  const [pin, setPin] = useState("");
  const smooth = useRef<SmoothView | undefined>(undefined);
  const [smoothState, setSmoothState] = useState<SmoothViewState>({
    wanted: false,
    phase: "off",
    message: "",
    unavailable: false,
  });
  const [connectionPath, setConnectionPath] = useState(session.path);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const unlocking = usePhoneUnlock(phoneId, session, initial, state, setState);
  useEffect(() => {
    if (state.localSettings) {
      touch.current?.release();
      frame.current = undefined;
    }
  }, [state.localSettings]);
  callbacks.current = {
    onContact,
    onEnded,
    unlockMessage: unlocking.connectionEndedMessage,
  };
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const input = canvas.current
      ? new TouchInput(canvas.current, session, () => frame.current, setMessage)
      : undefined;
    touch.current = input;
    let lastStatus = 0;
    const renderer = canvas.current
      ? new VideoRenderer(canvas.current, (meta) => {
          frame.current = meta;
          smooth.current?.displayed();
        })
      : undefined;
    const viewing = new SmoothView(session, setSmoothState, () =>
      renderer?.close(),
    );
    smooth.current = viewing;
    setSmoothState(viewing.state);
    async function capture() {
      if (input?.active && !viewing.readingVideo) {
        timer = setTimeout(() => {
          void capture();
        }, 150);
        return;
      }
      try {
        if (Date.now() - lastStatus > 1500) {
          const status = await session.command({ op: "status" });
          if (stopped) return;
          if (status.kind === "state") {
            viewing.observe(status.state.video);
            setState(status.state);
            callbacks.current.onContact?.(status.state);
            setConnectionPath(session.path);
          }
          lastStatus = Date.now();
        }
        const version = viewing.version;
        const reply = await session.command({
          op: viewing.readingVideo ? "videoFrame" : "capture",
        });
        if (stopped) return;
        if (version !== viewing.version) {
          timer = setTimeout(() => void capture(), 0);
          return;
        }
        if (reply.kind === "video" && viewing.readingVideo) {
          if (!renderer?.push(reply)) await session.command({ op: "videoKey" });
        } else if (
          viewing.readingVideo &&
          reply.kind === "result" &&
          reply.code === 6
        ) {
          // No frame is ready. The bounded encoder mailbox never queues an idle capture.
        } else if (reply.kind === "image") {
          const image = await createImageBitmap(
            new Blob([reply.jpeg], { type: "image/jpeg" }),
          );
          if (!stopped && version === viewing.version && canvas.current) {
            const target = canvas.current;
            target.width = reply.width;
            target.height = reply.height;
            target
              .getContext("2d")
              ?.drawImage(image, 0, 0, reply.width, reply.height);
            frame.current = reply;
            setMessage("");
          }
          image.close();
        } else if (reply.kind === "result") {
          frame.current = undefined;
          canvas.current
            ?.getContext("2d")
            ?.clearRect(0, 0, canvas.current.width, canvas.current.height);
          setMessage(resultMessage(reply.code));
          const status = await session.command({ op: "status" });
          if (!stopped && status.kind === "state") {
            setState(status.state);
            viewing.observe(status.state.video);
          }
        }
        if (!stopped)
          timer = setTimeout(
            () => {
              void capture();
            },
            viewing.readingVideo ? 16 : 650,
          );
      } catch (error) {
        if (!stopped) {
          if (error instanceof VideoDecodeError) {
            viewing.fail(error.message, true);
          } else setActionMessage("");
          setMessage(
            error instanceof Error ? error.message : "Connection ended",
          );
          frame.current = undefined;
          if (!session.connected)
            callbacks.current.onEnded?.(
              callbacks.current.unlockMessage() || undefined,
            );
          if (session.connected)
            timer = setTimeout(() => {
              void capture();
            }, 500);
        }
      }
    }
    void capture();
    return () => {
      stopped = true;
      clearTimeout(timer);
      viewing.close();
      if (smooth.current === viewing) smooth.current = undefined;
      input?.close();
      touch.current = undefined;
    };
  }, [session]);
  async function act(command: Command) {
    setActionMessage("");
    try {
      const reply = await session.command(command);
      if (command.op === "wake" || command.op === "sleep") {
        const status = await session.command({ op: "status" });
        if (status.kind === "state") setState(status.state);
      }
      if (reply.kind === "result" && reply.code)
        setActionMessage(resultMessage(reply.code));
    } catch (error) {
      setActionMessage(
        error instanceof Error ? error.message : "Connection ended",
      );
    }
  }
  return (
    <section
      ref={fullscreen.element}
      className="remote-viewer"
      data-fullscreen={fullscreen.active || undefined}
      aria-label="Remote screen"
      data-transport={connectionPath}
    >
      <ViewerHeading
        inline={fullscreen.active}
        name={name || state.device.name}
        status={
          notice ||
          (state.localSettings
            ? "Remote input paused · Change security settings on the phone"
            : "") ||
          unlocking.message ||
          actionMessage ||
          smoothState.message ||
          message ||
          (state.locked ? "Phone is locked" : "Connected securely")
        }
      />
      <ViewerWorkspace
        aspect={aspect ?? (initial.width || 1080) / (initial.height || 2400)}
        controls={
          <RemoteControls
            navigate={(action) => void act({ op: "navigation", action })}
            wake={() => void act({ op: "wake" })}
            lock={() => void act({ op: "sleep" })}
            smooth={() => {
              setActionMessage("");
              setMessage("");
              const viewing = smooth.current;
              viewing?.setEnabled(!viewing.state.wanted);
            }}
            smoothOn={smoothState.phase === "active"}
            smoothPending={smoothState.wanted && smoothState.phase !== "active"}
            smoothDisabled={
              !smoothState.wanted &&
              (!state.accessibility ||
                state.locked ||
                !state.video ||
                !VideoRenderer.supported() ||
                smoothState.unavailable)
            }
            smoothHint={
              smoothState.wanted
                ? "Turn off smooth view"
                : !state.accessibility
                  ? "Enable screen access on the phone to use Smooth view."
                  : state.locked
                    ? "Unlock the phone before starting Smooth view."
                    : !state.video
                      ? "Update the phone app to use Smooth view."
                      : !VideoRenderer.supported() || smoothState.unavailable
                        ? "This browser supports still frames."
                        : "Turn on smooth view"
            }
            type={() => typingDialog.current?.showModal()}
            disconnect={disconnect}
            fullscreen={fullscreen.active}
            toggleFullscreen={() => void fullscreen.toggle()}
          />
        }
      >
        <canvas
          ref={canvas}
          width={initial.width || 1080}
          height={initial.height || 2400}
          aria-label="Phone screen"
          className="phone-screen"
        />
        {!state.accessibility ? (
          <div className="screen-overlay">
            <div className="screen-panel">
              <h2>Enable screen access</h2>
              <p>
                On the phone, open YepControl › Settings and turn on Screen and
                control to enable viewing and touch. Pairing stays saved.
              </p>
            </div>
          </div>
        ) : state.localSettings ? (
          <div className="screen-overlay">
            <div className="screen-panel">
              <h2>Change these settings on the phone</h2>
              <p>
                Remote input is paused on pairing and unlock pages. Make changes
                on the phone, or return to ordinary controls. Back and Home
                still work remotely.
              </p>
            </div>
          </div>
        ) : (
          state.locked && (
            <div className="screen-overlay">
              <div className="screen-panel">
                <h2>Unlock phone</h2>
                {unlocking.message && <p>{unlocking.message}</p>}
                {!state.unlockAllowed && (
                  <p>
                    Allow unlocking for this browser in the phone app’s browser
                    settings.
                  </p>
                )}
                {state.unlockBlocked && (
                  <p>
                    Unlock was already attempted. Unlock the phone locally
                    before another attempt.
                  </p>
                )}
                {state.savedPin && !unlocking.busy && (
                  <button
                    className="saved-pin-button"
                    type="button"
                    disabled={!state.unlockAllowed || state.unlockBlocked}
                    onClick={() => void unlocking.unlock({ op: "unlockSaved" })}
                  >
                    Use saved PIN
                  </button>
                )}
                {!unlocking.busy && (
                  <form
                    className="unlock-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const value = pin;
                      setPin("");
                      void unlocking.unlock({ op: "unlock", pin: value });
                    }}
                  >
                    <label htmlFor="phone-pin">Phone PIN</label>
                    <div className="inline-field">
                      <input
                        id="phone-pin"
                        type="password"
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={16}
                        value={pin}
                        onChange={(e) => setPin(e.target.value)}
                      />
                      <button
                        type="submit"
                        disabled={!state.unlockAllowed || state.unlockBlocked}
                      >
                        Unlock phone
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </div>
          )
        )}
      </ViewerWorkspace>
      <dialog ref={typingDialog} aria-labelledby="typing-title">
        <div className="dialog-heading">
          <h2 id="typing-title">Type or open an app</h2>
          <button
            type="button"
            aria-label="Close typing controls"
            onClick={() => typingDialog.current?.close()}
          >
            ×
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void act({ op: "text", text });
            setText("");
          }}
        >
          <label>
            Text for the focused field
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoComplete="off"
            />
          </label>
          <button type="submit">Send text</button>
        </form>
        <button
          type="button"
          onClick={async () => {
            try {
              const reply = await session.command({ op: "apps" });
              if (reply.kind === "apps") setApps(reply.apps);
            } catch (error) {
              setMessage(
                error instanceof Error ? error.message : "Couldn’t load apps",
              );
            }
          }}
        >
          Choose an app
        </button>
        {apps.length > 0 && (
          <label>
            Open app
            <select
              aria-label="Open app"
              defaultValue=""
              onChange={(event) => {
                if (event.target.value)
                  void act({ op: "launch", packageName: event.target.value });
              }}
            >
              <option value="" disabled>
                Choose an app…
              </option>
              {apps.map((app) => (
                <option key={app.packageName} value={app.packageName}>
                  {app.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </dialog>
    </section>
  );
}
