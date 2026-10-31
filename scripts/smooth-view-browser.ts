import assert from "node:assert/strict";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { createServer } from "vite";

/** Actual React/WebCodecs ↔ native binary commands. Relay/auth transport is outside this harness. */
export async function smoothViewBrowser(
  root: string,
  state: string,
  exchange: (request: { action?: string; payload?: string }) => Promise<{
    payload?: string;
    video?: { phase: string };
    prompt?: boolean;
  }>,
) {
  const server = await createServer({
    configFile: false,
    root: path.join(root, "web"),
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root] }, hmr: false },
    plugins: [
      {
        name: "native-smooth-fixture",
        configureServer(vite) {
          vite.middlewares.use("/layout-proof", (_req, res) => {
            res.setHeader("Content-Type", "text/html");
            res.end(
              `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/@fs/${path.join(root, "web/test/layout-fixture.tsx")}"></script>`,
            );
          });
          vite.middlewares.use("/native-control", async (req, res) => {
            try {
              assert.equal(req.method, "POST");
              const chunks: Buffer[] = [];
              let length = 0;
              for await (const chunk of req) {
                length += chunk.length;
                assert.ok(length <= 32784);
                chunks.push(Buffer.from(chunk));
              }
              const reply = await exchange({
                payload: Buffer.concat(chunks).toString("base64"),
              });
              assert.ok(reply.payload);
              res.setHeader("Content-Type", "application/octet-stream");
              res.end(Buffer.from(reply.payload, "base64"));
            } catch {
              res.statusCode = 500;
              res.end("Native fixture failed");
            }
          });
        },
      },
    ],
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== "string");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/layout-proof?native`);
    const toggle = page.getByRole("switch", {
      name: "Smooth view",
      exact: true,
    });
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(page.getByRole("status")).toContainText(
      "Approve screen sharing",
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(toggle).not.toBeChecked();
    await exchange({ action: "approve" });
    await expect(toggle).toBeChecked({ timeout: 20000 });
    await page.screenshot({
      path: path.join(state, "smooth-native-browser.png"),
      fullPage: true,
    });
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(async () => (await exchange({ action: "inspect" })).video?.phase)
      .toBe("off");
    await toggle.click();
    await expect(page.getByRole("status")).toContainText(
      "Approve screen sharing",
    );
    await exchange({ action: "cancel" });
    await expect(toggle).toHaveAttribute("aria-busy", "false");
    await expect(toggle).not.toBeChecked();
    await page.waitForTimeout(1800);
    assert.equal((await exchange({ action: "inspect" })).prompt, false);
    await toggle.click();
    await toggle.click();
    await toggle.click();
    await expect(page.getByRole("status")).toContainText(
      "Approve screen sharing",
    );
    await exchange({ action: "approve" });
    await expect(toggle).toBeChecked({ timeout: 20000 });
    assert.equal((await exchange({ action: "inspect" })).prompt, false);
    // Camera selection must actually stop the screen source before exposing its controls.
    await page.getByRole("button", { name: "Camera", exact: true }).click();
    await expect(page.locator(".remote-viewer")).toHaveAttribute(
      "data-source",
      "camera",
    );
    await expect
      .poll(async () => (await exchange({ action: "inspect" })).video?.phase)
      .toBe("off");
    await expect(
      page.getByRole("navigation", { name: "Android navigation" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Screen", exact: true }).click();
    await expect(toggle).not.toBeChecked();
    assert.equal((await exchange({ action: "inspect" })).prompt, false);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}
