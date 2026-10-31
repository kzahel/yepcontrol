import type { PhoneFeatures } from "@remote/protocol/features";
import { ControlIcon, type ControlIconName } from "./control-icon.js";
import { MediaPreviewToolbar } from "./media-toolbar.js";
import { LastContact } from "./phone-list.js";
import { RemoteControls } from "./remote-controls.js";
import { ViewerWorkspace } from "./viewer-workspace.js";

export function PhonePreview({
  pending,
  connect,
  cancel,
  features,
  lastContactAt,
}: {
  pending: "check" | "control" | undefined;
  connect: () => void;
  cancel: () => void;
  features: PhoneFeatures | undefined;
  lastContactAt: number | undefined;
}) {
  return (
    <section className="remote-viewer phone-preview" aria-label="Phone preview">
      <MediaPreviewToolbar />
      <ViewerWorkspace controls={<RemoteControls />}>
        <div className="screen-overlay preview-overlay">
          <div className="screen-panel connect-panel">
            <button
              type="button"
              aria-label="Connect to phone"
              disabled={pending === "control"}
              onClick={connect}
            >
              {pending === "control" ? "Connecting…" : "Connect"}
            </button>
            <p className="contact-detail">
              <LastContact at={lastContactAt} />
            </p>
            <section className="preview-features" aria-label="Phone features">
              <Capability
                name="Screen viewing"
                label="Screen"
                icon="screen"
                value={features?.screenViewing}
                description={feature(features?.screenViewing)}
              />
              <Capability
                name="Touch control"
                label="Touch"
                icon="touch"
                value={features?.touchControl}
                description={feature(features?.touchControl)}
              />
              <Capability
                name="Connection requests"
                label="Requests"
                icon="notifications"
                value={features?.connectionRequests}
                description={requests(features?.connectionRequests)}
              />
            </section>
            <button
              className="secondary preview-cancel"
              type="button"
              disabled={!pending}
              style={{ visibility: pending ? "visible" : "hidden" }}
              onClick={cancel}
            >
              Cancel connection
            </button>
          </div>
        </div>
      </ViewerWorkspace>
    </section>
  );
}
function Capability({
  name,
  label,
  icon,
  value,
  description,
}: {
  name: string;
  label: string;
  icon: ControlIconName;
  value: string | undefined;
  description: string;
}) {
  const state =
    value === undefined ? "unknown" : value === "enabled" ? "enabled" : "off";
  return (
    <div
      className="capability"
      role="img"
      aria-label={`${name}: ${description}`}
      title={`${name}: ${description}`}
    >
      <span className="capability-icon" aria-hidden="true">
        <ControlIcon name={icon} />
        <span className="capability-indicator" data-state={state}>
          {state === "enabled" ? "✓" : state === "off" ? "−" : "?"}
        </span>
      </span>
      <span aria-hidden="true">{label}</span>
    </div>
  );
}
function feature(value: PhoneFeatures["screenViewing"] | undefined) {
  return value === undefined
    ? "Status unknown"
    : value === "enabled"
      ? "Enabled"
      : value === "permission-needed"
        ? "Off · Enable screen access in the phone app"
        : "Unavailable";
}
function requests(value: PhoneFeatures["connectionRequests"] | undefined) {
  return value === undefined
    ? "Status unknown"
    : value === "enabled"
      ? "Enabled"
      : value === "off"
        ? "Off"
        : value === "notifications-needed"
          ? "Enable notifications on the phone"
          : value === "setup-needed"
            ? "Review connection settings on the phone"
            : "Unavailable";
}
