/** Session-boundary fixture: exercise the real CLI process with an unread reply pipe. */

import { RemoteSession } from "@remote/client/control-session";
import { Store } from "../../src/store.js";

Store.load = async () =>
  ({
    identity: {},
    select: () => ({ grant: {}, origin: "https://example.test" }),
  }) as never;
RemoteSession.connect = async () =>
  ({
    state: {},
    session: {
      connected: true,
      close() {
        process.stderr.write("closed\n");
      },
      async command() {
        return {
          id: 2,
          kind: "image",
          scene: 1,
          width: 1080,
          height: 2400,
          jpeg: new Uint8Array(1000000),
        };
      },
    },
  }) as never;
await import("../../src/main.js");
