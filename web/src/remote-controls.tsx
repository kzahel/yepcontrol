import { useEffect, useId, useRef, useState } from "react";
import { ControlIcon } from "./control-icon.js";

export function RemoteControls({
  navigate,
  wake,
  lock,
  smooth,
  smoothOn = false,
  smoothPending = false,
  smoothDisabled = false,
  smoothHint = "Smooth view",
  type,
  disconnect,
  fullscreen = false,
  toggleFullscreen,
  screenInput = true,
  onExpandedChange,
}: {
  navigate?: (action: "back" | "home" | "recents") => void;
  wake?: () => void;
  lock?: () => void;
  smooth?: () => void;
  smoothOn?: boolean;
  smoothPending?: boolean;
  smoothDisabled?: boolean;
  smoothHint?: string;
  type?: () => void;
  disconnect?: () => void;
  fullscreen?: boolean;
  toggleFullscreen?: () => void;
  screenInput?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const extraId = useId();
  const dock = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const close = () => {
      setExpanded(false);
      onExpandedChange?.(false);
    };
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        !dock.current?.contains(event.target) &&
        !event.target.closest(".media-toolbar")
      )
        close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        close();
        dock.current
          ?.querySelector<HTMLButtonElement>(".more-controls")
          ?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [expanded, onExpandedChange]);
  function expand(next: boolean) {
    setExpanded(next);
    onExpandedChange?.(next);
  }
  const fullscreenLabel = fullscreen ? "Exit fullscreen" : "Fullscreen";
  return (
    <div ref={dock} className="control-dock">
      {screenInput && (
        <nav className="phone-nav" aria-label="Android navigation">
          {(["back", "home", "recents"] as const).map((action) => {
            const label =
              action === "back"
                ? "Back"
                : action === "home"
                  ? "Home"
                  : "Recents";
            return (
              <button
                key={action}
                type="button"
                aria-label={label}
                title={label}
                disabled={!navigate}
                onClick={() => navigate?.(action)}
              >
                <ControlIcon name={action} />
                <span className="control-label" aria-hidden="true">
                  {label}
                </span>
              </button>
            );
          })}
        </nav>
      )}
      <div
        className="auxiliary-controls"
        id={extraId}
        data-expanded={expanded || undefined}
      >
        {screenInput && (
          <>
            <div className="screen-controls">
              <button
                type="button"
                title="Wake screen"
                disabled={!wake}
                onClick={wake}
              >
                <ControlIcon name="wake" />
                <span className="control-label">Wake screen</span>
              </button>
              <button
                type="button"
                title="Lock phone"
                disabled={!lock}
                onClick={() => {
                  expand(false);
                  lock?.();
                }}
              >
                <ControlIcon name="lock" />
                <span className="control-label">Lock phone</span>
              </button>
            </div>
            <div className="screen-controls">
              <button
                type="button"
                role="switch"
                aria-label="Smooth view"
                aria-checked={smoothOn}
                aria-busy={smoothPending}
                title={smoothHint}
                data-pending={smoothPending || undefined}
                disabled={!smooth || smoothDisabled}
                onClick={smooth}
              >
                <span className="smooth-switch" aria-hidden="true" />
                <span className="smooth-label" aria-hidden="true">
                  Smooth
                </span>
                <span className="control-label" aria-hidden="true">
                  Smooth view
                </span>
              </button>
              <button
                type="button"
                title="Type or open an app"
                disabled={!type}
                onClick={() => {
                  expand(false);
                  type?.();
                }}
              >
                <ControlIcon name="keyboard" />
                <span className="control-label">Type or open an app</span>
              </button>
            </div>
          </>
        )}
        <div className="screen-controls">
          <button
            type="button"
            title="Disconnect"
            disabled={!disconnect}
            onClick={disconnect}
          >
            <ControlIcon name="disconnect" />
            <span className="control-label">Disconnect</span>
          </button>
        </div>
      </div>
      <button
        className="more-controls"
        type="button"
        title="More controls"
        aria-label="More controls"
        aria-controls={extraId}
        aria-expanded={expanded}
        onClick={() => expand(!expanded)}
      >
        <ControlIcon name="menu" />
        <span className="control-label" aria-hidden="true">
          More
        </span>
      </button>
      {toggleFullscreen && (
        <button
          type="button"
          title={fullscreenLabel}
          aria-label={fullscreenLabel}
          onClick={() => {
            expand(false);
            toggleFullscreen();
          }}
        >
          <ControlIcon name={fullscreen ? "exit-fullscreen" : "fullscreen"} />
          <span className="control-label" aria-hidden="true">
            {fullscreenLabel}
          </span>
        </button>
      )}
    </div>
  );
}
