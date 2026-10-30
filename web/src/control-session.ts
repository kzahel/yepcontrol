import {
  type Lane,
  RemoteSession as SharedSession,
} from "@remote/client/control-session";
import type { Identity } from "@remote/protocol";
import type { Grant } from "@remote/protocol/enrollment";
import { openDirectLane } from "./direct-lane.js";
import { openEncryptedSession } from "./relay.js";
export type RemoteSession = SharedSession;
export const RemoteSession = {
  connect(
    identity: Identity,
    grant: Grant,
    report: (s: string) => void,
    signal: AbortSignal,
    prepared?: Lane,
  ) {
    return SharedSession.connect(
      identity,
      grant,
      report,
      signal,
      {
        open: openEncryptedSession,
        ...(typeof RTCPeerConnection === "undefined"
          ? {}
          : { direct: openDirectLane }),
      },
      prepared,
    );
  },
};
