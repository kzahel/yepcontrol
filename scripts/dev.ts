/** Local relay and viewer, published to this tailnet over HTTPS by a foreground `tailscale serve`. */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { viewerAssetPath } from "../web/routes.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const httpsPort = Number(process.env.DEV_HTTPS_PORT ?? "443");
const relayPort = Number(process.env.DEV_RELAY_PORT ?? "4888");
const viewerPort = Number(process.env.DEV_VIEWER_PORT ?? "5173");
const status = JSON.parse(
  execFileSync("tailscale", ["status", "--json"], { encoding: "utf8" }),
) as { BackendState: string; Self: { DNSName: string } };
if (status.BackendState !== "Running")
  throw new Error(`Tailscale is ${status.BackendState}; start it first`);
const host = status.Self.DNSName.replace(/\.$/, "");
const origin = `https://${host}${httpsPort === 443 ? "" : `:${httpsPort}`}`;

execFileSync("pnpm", ["--filter", "@remote/protocol", "build"], {
  cwd: root,
  stdio: "inherit",
});
const children: ChildProcess[] = [];
let stopping = false;
function child(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const proc = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  proc.on("exit", (code) => {
    if (!stopping) {
      console.error(`${command} exited (${code}); stopping`);
      void stop(1);
    }
  });
  children.push(proc);
}
child("pnpm", ["exec", "tsx", "watch", "relay/src/index.ts"], {
  PORT: String(relayPort),
  PUBLIC_ORIGIN: origin,
  STATE_DIRECTORY: path.join(root, ".local/dev-relay"),
  REVISION: "development",
});
const relay = `http://127.0.0.1:${relayPort}`;
const viewer = await createServer({
  configFile: false,
  root: path.join(root, "web"),
  server: {
    host: "127.0.0.1",
    port: viewerPort,
    strictPort: true,
    allowedHosts: [host],
    hmr: { clientPort: httpsPort },
    proxy: { "/api": { target: relay, ws: true }, "/health": relay },
  },
  plugins: [
    {
      name: "viewer-routes",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const route = req.url?.split("?")[0];
          if (
            route &&
            (route === "/" ||
              route === "/phones" ||
              route === "/pair" ||
              route === "/control" ||
              route.startsWith("/phones/") ||
              route === "/install" ||
              route === "/enroll" ||
              route === "/privacy" ||
              route === "/privacy/")
          )
            req.url = viewerAssetPath(route);
          next();
        });
      },
    },
  ],
});
await viewer.listen();
// Foreground serve removes its configuration when it exits.
child("tailscale", [
  "serve",
  `--https=${httpsPort}`,
  `http://127.0.0.1:${viewerPort}`,
]);

async function stop(code = 0) {
  stopping = true;
  for (const proc of children) if (proc.exitCode === null) proc.kill("SIGINT");
  await viewer.close();
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => void stop());
console.log(`
Development relay: ${origin}
Open it on a tailnet device and scan its pairing code with the phone app.
Debug app: add devSharingWebsite=${origin} to android/local.properties and rebuild.
In the phone app's Settings, enable Use development website before scanning.
Relay state: .local/dev-relay (remote wake needs FIREBASE_PROJECT_ID and credentials)
`);
