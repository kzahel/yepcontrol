import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "@playwright/test";

/** Exercise built viewer changes at the real origin before deployment. Only
 * static browser assets are replaced; pairing, sockets and FCM use the relay. */
export async function candidateViewer(context: BrowserContext, origin: string) {
  const directory = process.env.HOSTED_VIEWER_DIRECTORY;
  if (!directory) return;
  const root = path.resolve(directory);
  await context.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const navigation =
      request.isNavigationRequest() &&
      (url.pathname === "/" ||
        url.pathname === "/pair" ||
        url.pathname === "/control" ||
        url.pathname.startsWith("/phones"));
    if (
      !navigation &&
      !url.pathname.startsWith("/assets/") &&
      url.pathname !== "/appearance.js"
    ) {
      await route.fallback();
      return;
    }
    const file = path.resolve(
      root,
      navigation
        ? url.pathname === "/"
          ? "index.html"
          : "viewer.html"
        : `.${url.pathname}`,
    );
    if (!file.startsWith(`${root}${path.sep}`))
      throw new Error("Invalid viewer asset");
    await route.fulfill({
      body: await readFile(file),
      contentType: file.endsWith(".html")
        ? "text/html"
        : file.endsWith(".css")
          ? "text/css"
          : "application/javascript",
    });
  });
}
