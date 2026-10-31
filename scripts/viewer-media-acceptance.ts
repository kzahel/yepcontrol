import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";
import { createServer } from "vite";
import {
  mediaBrowserEvidence,
  observeMediaBrowser,
} from "./media-browser-evidence.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(
  root,
  ".local/media-access/implementation/phase-4/browser",
);
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const server = await createServer({
  configFile: false,
  root: path.join(root, "web"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root] }, hmr: false },
  plugins: [
    {
      name: "media-ui-proof",
      configureServer(vite) {
        vite.middlewares.use("/media-proof", (_req, res) => {
          res.setHeader("Content-Type", "text/html");
          res.end(
            `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/appearance.js"></script><div id="root"></div><script type="module" src="/@fs/${path.join(root, "web/test/layout-fixture.tsx")}"></script>`,
          );
        });
      },
    },
  ],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let active: Page | undefined;
const results: unknown[] = [];
async function phase(
  page: Page,
  sensor: "camera" | "microphone",
  value: string,
) {
  await expect(page.locator(`.${sensor}-state`)).toHaveAttribute(
    "data-phase",
    value,
  );
}
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address !== "string");
  browser = await chromium.launch({ headless: true });
  for (const [name, width, height] of [
    ["desktop", 1280, 1000],
    ["mobile", 390, 844],
    ["small-mobile", 320, 680],
    ["landscape", 844, 390],
  ] as const) {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    active = page;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await observeMediaBrowser(page);
    const url = `http://127.0.0.1:${address.port}/media-proof?media=1&locked=false&savedPin=false`;
    await page.goto(url);
    await expect(
      page.getByRole("button", { name: "Screen", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() =>
        page.evaluate(() => window.layoutFixture.sensors?.starts.length),
      )
      .toBe(0);
    await page.getByRole("button", { name: "Camera", exact: true }).click();
    await phase(page, "camera", "off");
    await page.evaluate(() =>
      window.layoutFixture.sensors?.configure("camera", { permission: false }),
    );
    await expect(
      page.getByRole("button", { name: "Start camera", exact: true }),
    ).toBeDisabled();
    await expect(page.locator(".camera-state")).toContainText(
      "Allow camera permission",
    );
    await expect(
      page.getByRole("button", { name: "Listen", exact: true }),
    ).toBeEnabled();
    await page.evaluate(() =>
      window.layoutFixture.sensors?.configure("camera", { permission: true }),
    );
    await expect(
      page.getByRole("button", { name: "Start camera", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("navigation", { name: "Android navigation" }),
    ).toHaveCount(0);
    await page.getByLabel("Camera quality").selectOption("still");
    await page
      .getByLabel("Phone camera", { exact: true })
      .selectOption("front");
    await page
      .getByRole("button", { name: "Start camera", exact: true })
      .press("Enter");
    await phase(page, "camera", "live");
    await expect
      .poll(async () => (await mediaBrowserEvidence(page)).drawn)
      .toBeGreaterThan(0);
    await page.getByLabel("Phone camera preview", { exact: true }).click();
    assert.equal(
      await page.evaluate(() =>
        window.layoutFixture.trace.some((line) => line.startsWith("touch:")),
      ),
      false,
    );
    await page.evaluate(() =>
      window.layoutFixture.sensors?.configure("microphone", {
        permission: false,
      }),
    );
    await expect(
      page.getByRole("button", { name: "Listen", exact: true }),
    ).toBeDisabled();
    await phase(page, "camera", "live");
    await page.evaluate(() =>
      window.layoutFixture.sensors?.configure("microphone", {
        permission: true,
      }),
    );
    await expect(
      page.getByRole("button", { name: "Listen", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Listen", exact: true })
      .press("Enter");
    await phase(page, "microphone", "live");
    await expect
      .poll(async () => (await mediaBrowserEvidence(page)).peak)
      .toBeGreaterThan(0.01);
    const playing = await mediaBrowserEvidence(page);
    assert(playing.played > 0);
    assert(playing.contexts.includes("running"));
    assert(playing.destinationConnections > 0);
    await page
      .getByRole("button", { name: "Stop camera", exact: true })
      .click();
    await phase(page, "camera", "off");
    await page.evaluate(() =>
      window.layoutFixture.sensors?.contend("camera", true),
    );
    await page
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await expect(page.locator(".camera-state")).toContainText(
      "sensor is in use",
    );
    await phase(page, "microphone", "live");
    await page.evaluate(() =>
      window.layoutFixture.sensors?.contend("camera", false),
    );
    await page
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await phase(page, "camera", "live");
    const stopCount = await page.evaluate(
      () => window.layoutFixture.sensors?.stops.length,
    );
    await page.evaluate(() => window.layoutFixture.sensors?.burst());
    await phase(page, "microphone", "live");
    assert.equal(
      await page.evaluate(() => window.layoutFixture.sensors?.stops.length),
      stopCount,
    );
    const burstProof = await mediaBrowserEvidence(page);
    assert(
      burstProof.maxAhead <= 0.251,
      "Playback queue never exceeds 250 ms, including bursts",
    );
    // Exercise the visibility handler explicitly: automated Chromium keeps tabs
    // visible. The real-host runner separately confirms a complete JavaScript pause.
    const startsBeforeHidden = await page.evaluate(
      () => window.layoutFixture.sensors?.starts.length,
    );
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        value: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await phase(page, "camera", "off");
    await phase(page, "microphone", "off");
    assert.deepEqual(
      await page.evaluate(() => window.layoutFixture.sensors?.active()),
      [],
    );
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(
      await page.evaluate(() => window.layoutFixture.sensors?.starts.length),
      startsBeforeHidden,
    );
    await page
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await phase(page, "camera", "live");
    await page.getByRole("button", { name: "Listen", exact: true }).click();
    await phase(page, "microphone", "live");
    const fits = await page.locator(".screen-stage").boundingBox();
    assert(fits && fits.y + fits.height <= height + 1);
    const picture = await page
      .getByLabel("Phone camera preview", { exact: true })
      .boundingBox();
    assert(
      picture && Math.abs(picture.width / picture.height - 4 / 3) < 0.02,
      "Camera display preserves the frame aspect ratio",
    );
    assert(
      picture.x >= fits.x &&
        picture.y >= fits.y &&
        picture.x + picture.width <= fits.x + fits.width + 1 &&
        picture.y + picture.height <= fits.y + fits.height + 1,
      "Camera fits without cropping",
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(artifacts, `${name}-camera-listening.png`),
    });
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect(page.locator(".remote-viewer")).toHaveAttribute(
      "data-fullscreen",
      "true",
    );
    await expect(
      page.getByRole("button", { name: "Stop listening", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Exit fullscreen", exact: true })
      .click();
    await page.getByRole("button", { name: "Screen", exact: true }).click();
    await expect(
      page.getByLabel("Phone screen", { exact: true }),
    ).toBeVisible();
    await phase(page, "microphone", "live");
    assert.deepEqual(
      await page.evaluate(() => window.layoutFixture.sensors?.active()),
      ["microphone"],
    );
    await page
      .getByRole("button", { name: "Stop listening", exact: true })
      .click();
    await phase(page, "microphone", "off");
    await expect
      .poll(async () =>
        (await mediaBrowserEvidence(page)).contexts.every(
          (state) => state === "closed",
        ),
      )
      .toBe(true);
    // A real AudioContext suspension must stop native capture, not just mute local playback.
    await page.getByRole("button", { name: "Listen", exact: true }).click();
    await phase(page, "microphone", "live");
    await page.evaluate(() =>
      window.mediaBrowserEvidence.contexts.at(-1)?.suspend(),
    );
    await phase(page, "microphone", "off");
    await expect(page.locator(".microphone-state")).toContainText(
      "playback paused",
    );
    assert.deepEqual(
      await page.evaluate(() => window.layoutFixture.sensors?.active()),
      [],
    );
    // Cancel while native startup is pending; its eventual completion cannot restart capture.
    await page.getByRole("button", { name: "Camera", exact: true }).click();
    await page.evaluate(() => window.layoutFixture.sensors?.delay(1000));
    const before = await page.evaluate(
      () => window.layoutFixture.sensors?.starts.length,
    );
    await page
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await phase(page, "camera", "starting");
    await page
      .getByRole("button", { name: "Stop camera", exact: true })
      .click();
    await phase(page, "camera", "off");
    await page.waitForTimeout(1100);
    assert.equal(
      await page.evaluate(() => window.layoutFixture.sensors?.starts.length),
      before,
    );
    await page.evaluate(() => window.layoutFixture.sensors?.delay(0));
    await page
      .getByRole("button", { name: "Start camera", exact: true })
      .click();
    await phase(page, "camera", "live");
    await page.evaluate(() =>
      window.layoutFixture.sensors?.revoke("camera", "disabled"),
    );
    await phase(page, "camera", "off");
    await expect(page.locator(".camera-state")).toContainText("turned off");
    assert.deepEqual(
      await page.evaluate(() => window.layoutFixture.sensors?.active()),
      [],
    );
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Screen", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    assert.deepEqual(
      await page.evaluate(() => window.layoutFixture.sensors?.starts),
      [],
    );
    const proof = await mediaBrowserEvidence(page);
    assert.equal(proof.localRequests, 0);
    assert.deepEqual(errors, []);
    results.push({
      name,
      playing,
      burstProof,
      cleanup: true,
      noLocalCapture: true,
      syntheticVisibilityHandler: true,
    });
    await context.close();
    console.log(
      `${name}: camera, independent playback, source/fullscreen, native Stop and canceled start passed`,
    );
  }
  const legacy = await browser.newPage();
  active = legacy;
  await observeMediaBrowser(legacy);
  await legacy.goto(
    `http://127.0.0.1:${address.port}/media-proof?locked=false&savedPin=false`,
  );
  await legacy.getByRole("button", { name: "Camera", exact: true }).click();
  await expect(
    legacy.getByRole("button", { name: "Start camera", exact: true }),
  ).toBeDisabled();
  await expect(
    legacy.getByRole("button", { name: "Listen", exact: true }),
  ).toBeDisabled();
  await expect(legacy.locator(".camera-state")).toContainText(
    "Update YepControl",
  );
  assert.equal((await mediaBrowserEvidence(legacy)).localRequests, 0);
  results.push({ legacyHostRefusedLocally: true });
  await legacy.close();
  await writeFile(
    path.join(artifacts, "result.json"),
    JSON.stringify(results, null, 2),
    { mode: 0o600 },
  );
} catch (error) {
  await active
    ?.screenshot({ path: path.join(artifacts, "failure.png") })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
