import type { RemoteKey } from "@remote/protocol/control";
import { type RefObject, useId } from "react";

const navigation = [
  ["up", "Up", "↑"],
  ["left", "Left", "←"],
  ["center", "Select", "OK"],
  ["right", "Right", "→"],
  ["down", "Down", "↓"],
] as const;
const media = [
  ["rewind", "Rewind"],
  ["play-pause", "Play / pause"],
  ["fast-forward", "Fast-forward"],
  ["previous", "Previous"],
  ["stop", "Stop"],
  ["next", "Next"],
] as const;
const keyboard = new Map<string, RemoteKey>([
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
]);

export function KeyRemote({
  dialog,
  keys,
  disabled,
  send,
  message,
  navigate,
}: {
  dialog: RefObject<HTMLDialogElement | null>;
  keys: RemoteKey[];
  disabled: boolean;
  send: (key: RemoteKey) => void;
  message: string;
  navigate: (action: "back" | "home") => void;
}) {
  const title = useId();
  const press = (key: RemoteKey) => {
    if (!disabled && keys.includes(key)) send(key);
  };
  return (
    <dialog
      ref={dialog}
      className="remote-key-dialog"
      aria-labelledby={title}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          dialog.current?.close();
          return;
        }
        const key = keyboard.get(event.key);
        if (!key || event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        if (!event.repeat) press(key);
      }}
    >
      <h2 id={title}>Remote keys</h2>
      {navigation.some(([key]) => keys.includes(key)) && (
        <fieldset className="remote-dpad" aria-label="Directional pad">
          {navigation.map(([key, label, symbol]) => (
            <button
              key={key}
              type="button"
              aria-label={label}
              style={{ gridArea: key }}
              disabled={disabled || !keys.includes(key)}
              onClick={() => press(key)}
            >
              {symbol}
            </button>
          ))}
        </fieldset>
      )}
      <fieldset className="remote-media-keys" aria-label="Playback">
        {media
          .filter(([key]) => keys.includes(key))
          .map(([key, label]) => (
            <button
              key={key}
              type="button"
              disabled={disabled}
              onClick={() => press(key)}
            >
              {label}
            </button>
          ))}
      </fieldset>
      {(disabled || message) && (
        <p role="status">
          {message || "Remote input is currently unavailable."}
        </p>
      )}
      <form method="dialog" className="remote-key-actions">
        <button
          type="button"
          className="secondary"
          onClick={() => navigate("back")}
        >
          Back
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => navigate("home")}
        >
          Home
        </button>
        <button type="submit" className="secondary">
          Close
        </button>
      </form>
    </dialog>
  );
}
