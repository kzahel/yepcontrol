import type { RemoteSession } from "@remote/client/control-session";
import type { ControlState } from "@remote/protocol/control";
import { createRoot } from "react-dom/client";
import { AppShell } from "../src/app-shell.js";
import { RemoteScreen } from "../src/remote-screen.js";
import "../src/viewer.css";

/** Mount the real viewer against the already-paired candidate session, with no saved credentials. */
export function mountMediaViewer(
  target: HTMLElement,
  session: RemoteSession,
  initial: ControlState,
  id: string,
) {
  const root = createRoot(target);
  root.render(
    <AppShell phones={[]}>
      <main className="connected-viewer">
        <RemoteScreen
          phoneId={id}
          session={session}
          initial={initial}
          disconnect={() => session.close()}
          onEnded={() => {
            document.body.dataset.connectionEnded = "true";
          }}
        />
      </main>
    </AppShell>,
  );
  return root;
}
