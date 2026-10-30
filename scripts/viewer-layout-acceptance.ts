import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserContext,
  chromium,
  expect,
  type Page,
} from "@playwright/test";
import { createServer } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(root, ".local/viewer-layout-proof");
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  configFile: false,
  root: path.join(root, "web"),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
  plugins: [
    {
      name: "layout-proof",
      configureServer(vite) {
        vite.middlewares.use("/layout-proof", (_req, res) => {
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
async function geometry(page: Page) {
  return page.evaluate(() => ({
    scroll: { x: scrollX, y: scrollY },
    boxes: [
      ".viewer-heading h1",
      ".viewer-status",
      ".screen-stage",
      ".control-dock",
    ].map((selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      if (!rect) throw Error(`Missing ${selector}`);
      return {
        selector,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }),
  }));
}
type Geometry = Awaited<ReturnType<typeof geometry>>;
async function stable(page: Page, baseline: Geometry) {
  const current = await geometry(page);
  assert.deepEqual(
    current,
    baseline,
    "Viewer geometry and page scroll must remain unchanged",
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "No horizontal page overflow",
  );
}
const results: unknown[] = [];
let activePage: Page | undefined;
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string")
    throw Error("No fixture address");
  browser = await chromium.launch({ headless: true });
  for (const [name, width, height] of [
    ["desktop", 1280, 1000],
    ["wide-desktop", 1728, 997],
    ["mobile", 390, 844],
    ["small-mobile", 320, 680],
    ["landscape", 844, 390],
  ] as const) {
    const context: BrowserContext = await browser.newContext({
      viewport: { width, height },
      colorScheme: "light",
    });
    const page = await context.newPage();
    activePage = page;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.type());
      void dialog.dismiss();
    });
    await page.goto(`http://127.0.0.1:${address.port}/layout-proof`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Test phone",
    );
    await expect(page.getByRole("status")).toHaveCount(1);
    const baseline = await geometry(page);
    assert.equal(baseline.scroll.y, 0);
    const stage = baseline.boxes[2];
    const rail = baseline.boxes[3];
    assert.ok(
      stage && rail && rail.x >= stage.x + stage.width,
      "Controls sit to the right of the screen",
    );
    assert.ok(stage.y + stage.height <= height, "Screen fits the viewport");
    if (width >= 900) {
      // Wide windows always show the sidebar and offer no menu toggle.
      await expect(page.locator(".app-sidebar")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Toggle navigation" }),
      ).toHaveCount(0);
      // Becoming "In use" must not resize the selected phone's row.
      const row = page.locator(".sidebar-phone-row").first();
      const idle = await row.boundingBox();
      await page.evaluate(() => {
        void navigator.locks.request(
          `remote-access-phone:${"a".repeat(64)}`,
          () => new Promise(() => {}),
        );
        new BroadcastChannel("remote-access-activity").postMessage("change");
      });
      await expect(row.getByText("In use")).toBeVisible();
      assert.deepEqual(
        await row.boundingBox(),
        idle,
        "Phone row keeps its size",
      );
    } else {
      await page.getByRole("button", { name: "Toggle navigation" }).click();
      await expect(
        page.getByRole("dialog", { name: "Navigation", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Toggle navigation" }),
      ).toBeFocused();
      await page.getByRole("button", { name: "Toggle navigation" }).click();
      await page.mouse.click(width - 8, height / 2);
      await expect(
        page.getByRole("dialog", { name: "Navigation", exact: true }),
      ).toBeHidden();
    }
    await stable(page, baseline);
    await page.screenshot({
      path: path.join(artifacts, `${name}-locked.png`),
      fullPage: true,
    });
    await expect
      .poll(() => page.evaluate(() => window.layoutFixture.unlocks))
      .toEqual(["unlockSaved"]);
    assert.deepEqual(
      dialogs,
      [],
      "Saved PIN unlock runs automatically without a confirmation dialog",
    );
    await expect(page.locator(".screen-overlay")).toBeHidden();
    await stable(page, baseline);
    await expect
      .poll(() =>
        page
          .locator("canvas")
          .evaluate(
            (c) =>
              (c as HTMLCanvasElement)
                .getContext("2d")
                ?.getImageData(0, 0, 1, 1).data[1] ?? 0,
          ),
      )
      .toBeGreaterThan(10);
    await stable(page, baseline); // First decoded still cannot resize the stage.
    if (width >= 900) {
      const screen = await page.locator("canvas").boundingBox();
      assert.ok(screen && rail);
      assert.ok(
        rail.x - screen.x - screen.width <= 16,
        "Controls stay beside the portrait phone on wide desktops",
      );
    }
    await page.screenshot({
      path: path.join(artifacts, `${name}-unlocked.png`),
      fullPage: true,
    });
    await page.evaluate(() =>
      window.layoutFixture.patch({ localSettings: true }),
    );
    await expect(
      page.getByRole("heading", {
        name: "Change these settings on the phone",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(/Remote input is paused on pairing and unlock pages/),
    ).toBeVisible();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.screenshot({
      path: path.join(artifacts, `${name}-local-settings.png`),
      fullPage: true,
    });
    await stable(page, baseline);
    await page.evaluate(() =>
      window.layoutFixture.patch({ localSettings: false }),
    );
    await expect(page.locator(".screen-overlay")).toBeHidden();
    // Native fullscreen and its viewport fallback keep the same live canvas.
    await page.locator("canvas").evaluate((c) => {
      c.setAttribute("data-fullscreen-original", "yes");
    });
    for (const mode of ["native", "unsupported", "rejected"] as const) {
      if (mode === "unsupported")
        await page.evaluate(() => {
          Object.defineProperty(document, "fullscreenEnabled", {
            value: false,
            configurable: true,
          });
        });
      if (mode === "rejected")
        await page.locator(".remote-viewer").evaluate((element) => {
          element.requestFullscreen = () =>
            Promise.reject(new TypeError("Fixture fullscreen rejection"));
        });
      await page
        .getByRole("button", { name: "Fullscreen", exact: true })
        .click();
      await expect(page.locator(".remote-viewer")).toHaveAttribute(
        "data-fullscreen",
        "true",
      );
      assert.equal(
        await page.evaluate(() => document.fullscreenElement !== null),
        mode === "native",
      );
      await expect(page.locator("canvas")).toHaveAttribute(
        "data-fullscreen-original",
        "yes",
      );
      await expect(page.getByRole("status")).toHaveCount(1);
      await expect(page.getByRole("status")).toBeVisible();
      const screen = await page.locator(".screen-stage").boundingBox();
      const dock = await page.locator(".control-dock").boundingBox();
      const image = await page.locator("canvas").boundingBox();
      assert.ok(screen && dock && image);
      assert.ok(
        dock.y >= screen.y + screen.height - 1,
        "Navigation is below the screen",
      );
      assert.ok(
        dock.y + dock.height <= height + 1,
        "Navigation fits the viewport",
      );
      assert.ok(image.x >= screen.x - 1 && image.y >= screen.y - 1);
      assert.ok(image.x + image.width <= screen.x + screen.width + 1);
      assert.ok(image.y + image.height <= screen.y + screen.height + 1);
      assert.ok(Math.abs(image.width / image.height - 1080 / 2400) < 0.01);
      for (const action of ["Back", "Home", "Recents"]) {
        await page.getByRole("button", { name: action, exact: true }).click();
        await expect(page.locator(".remote-viewer")).toHaveAttribute(
          "data-fullscreen",
          "true",
        );
      }
      await page
        .getByRole("button", { name: "More controls", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Type or open an app", exact: true })
        .click();
      await expect(
        page.getByRole("dialog", { name: "Type or open an app", exact: true }),
      ).toBeVisible();
      if (mode === "unsupported") {
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toBeHidden();
        await expect(page.locator(".remote-viewer")).toHaveAttribute(
          "data-fullscreen",
          "true",
        );
      } else {
        await page
          .getByRole("button", { name: "Close typing controls", exact: true })
          .click();
      }
      await page
        .getByRole("button", { name: "More controls", exact: true })
        .click();
      await page.screenshot({
        path: path.join(artifacts, `${name}-fullscreen-${mode}.png`),
      });
      if (mode === "native") {
        // Exit outside our button, as the browser does for local Back/Escape.
        // Hold a pointer first to prove that exit releases remote input.
        await page.mouse.move(
          image.x + image.width / 2,
          image.y + image.height / 2,
        );
        await page.mouse.down();
        await expect
          .poll(() =>
            page.evaluate(() =>
              window.layoutFixture.trace.some((line) =>
                line.startsWith("touch:"),
              ),
            ),
          )
          .toBe(true);
        await page.evaluate(() => document.exitFullscreen());
        await expect
          .poll(() =>
            page.evaluate(() =>
              window.layoutFixture.trace.some((line) =>
                line.startsWith("release:"),
              ),
            ),
          )
          .toBe(true);
        await page.mouse.up();
      } else if (mode === "unsupported") {
        await page.keyboard.press("Escape");
      } else {
        await page
          .getByRole("button", { name: "Exit fullscreen", exact: true })
          .click();
      }
      await expect(page.locator(".remote-viewer")).not.toHaveAttribute(
        "data-fullscreen",
      );
      await expect(page.locator("canvas")).toHaveAttribute(
        "data-fullscreen-original",
        "yes",
      );
      await stable(page, baseline);
      if (mode === "unsupported")
        await page.evaluate(() =>
          Reflect.deleteProperty(document, "fullscreenEnabled"),
        );
      if (mode === "rejected")
        await page
          .locator(".remote-viewer")
          .evaluate((element) =>
            Reflect.deleteProperty(element, "requestFullscreen"),
          );
    }
    for (const button of ["Back", "Home", "Recents", "Wake screen"]) {
      await page.getByRole("button", { name: button, exact: true }).click();
      await stable(page, baseline);
    }
    await page.getByRole("button", { name: "Lock phone", exact: true }).click();
    await expect(page.getByLabel("Phone PIN", { exact: true })).toBeVisible();
    assert.deepEqual(
      await page.evaluate(() => window.layoutFixture.unlocks),
      ["unlockSaved"],
      "Locking during a session must not trigger automatic unlock",
    );
    await stable(page, baseline);
    await page.getByLabel("Phone PIN", { exact: true }).fill("1234");
    await page
      .getByRole("button", { name: "Unlock phone", exact: true })
      .click();
    await expect(page.locator(".screen-overlay")).toBeHidden();
    await stable(page, baseline);
    await page.evaluate(() => window.layoutFixture.failNext());
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("deliberately long");
    await stable(page, baseline);
    await page.evaluate(() =>
      window.layoutFixture.patch({ locked: true, unlockBlocked: true }),
    );
    await expect(
      page.getByText("Unlock was already attempted.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Use saved PIN", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Unlock phone", exact: true }),
    ).toBeDisabled();
    await stable(page, baseline);
    await page.evaluate(() =>
      window.layoutFixture.patch({ accessibility: false }),
    );
    await expect(
      page.getByRole("heading", { name: "Enable screen access" }),
    ).toBeVisible();
    await stable(page, baseline);
    await page.evaluate(() =>
      window.layoutFixture.patch({
        locked: false,
        unlockBlocked: false,
        accessibility: true,
        width: 2400,
        height: 1080,
        scene: 2,
      }),
    );
    await expect
      .poll(() =>
        page.locator("canvas").evaluate((c) => (c as HTMLCanvasElement).width),
      )
      .toBe(2400);
    await stable(page, baseline); // Rotation changes only the contained image.
    const canvas = await page.locator("canvas").boundingBox();
    assert.ok(canvas);
    assert.ok(
      Math.abs(canvas.width / canvas.height - 2400 / 1080) < 0.01,
      "Displayed canvas preserves touch coordinate aspect ratio",
    );
    await expect(
      page.getByRole("heading", { name: "Enable screen access" }),
    ).toBeHidden();
    for (const [open, close] of [
      ["Type or open an app", "Close typing controls"],
    ] as const) {
      await page.getByRole("button", { name: open, exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await stable(page, baseline);
      if (open === "Type or open an app") {
        await page
          .getByLabel("Text for the focused field")
          .pressSequentially("Synthetic fixture text", { delay: 12 });
        await expect(page.getByLabel("Text for the focused field")).toHaveValue(
          "Synthetic fixture text",
        );
        await page
          .getByRole("button", { name: "Send text", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Choose an app", exact: true })
          .click();
        await page
          .getByRole("combobox", { name: "Open app", exact: true })
          .selectOption("test.fixture.app");
        await stable(page, baseline);
      }
      await page.getByRole("button", { name: close, exact: true }).click();
      await stable(page, baseline);
    }
    // Settings overlay preserves the existing canvas and running session.
    await page
      .locator("canvas")
      .evaluate((c) => c.setAttribute("data-original", "yes"));
    if (width < 900)
      await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await expect(settings).toBeVisible();
    await stable(page, baseline);
    await page.getByLabel("Dark", { exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByLabel("Show control labels").check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.locator(".viewer-workspace")).toHaveAttribute(
      "data-labels",
      "true",
    );
    await expect(page.locator("canvas")).toHaveAttribute(
      "data-original",
      "yes",
    );
    await page.screenshot({
      path: path.join(artifacts, `${name}-dark-labels.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect(page.locator(".remote-viewer")).toHaveAttribute(
      "data-fullscreen",
      "true",
    );
    const labeledBar = await page.locator(".control-dock").boundingBox();
    assert.ok(labeledBar);
    for (const label of [
      "Back",
      "Home",
      "Recents",
      "More controls",
      "Exit fullscreen",
    ]) {
      const button = await page
        .getByRole("button", { name: label, exact: true })
        .boundingBox();
      assert.ok(button && button.width >= 44 && button.height >= 44);
      assert.ok(button.x >= 0 && button.x + button.width <= width);
      assert.ok(button.y >= labeledBar.y && button.y + button.height <= height);
    }
    await page.screenshot({
      path: path.join(artifacts, `${name}-fullscreen-labels.png`),
    });
    await page
      .getByRole("button", { name: "Exit fullscreen", exact: true })
      .click();
    await expect(page.locator(".remote-viewer")).not.toHaveAttribute(
      "data-fullscreen",
    );
    if (width < 900)
      await page.getByRole("button", { name: "Toggle navigation" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Show control labels").uncheck();
    await page.getByLabel("System", { exact: true }).check();
    await page.getByRole("button", { name: "Close settings" }).click();
    await stable(page, baseline);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(() =>
        page
          .locator("html")
          .evaluate((html) => getComputedStyle(html).backgroundColor),
      )
      .toBe("rgb(20, 26, 24)");
    await page.emulateMedia({ colorScheme: "light" });
    await expect
      .poll(() =>
        page
          .locator("html")
          .evaluate((html) => getComputedStyle(html).backgroundColor),
      )
      .toBe("rgb(246, 248, 247)");
    await stable(page, baseline);
    if (name === "desktop") {
      const peer = await page.context().newPage();
      await peer.goto(page.url());
      await peer.getByRole("button", { name: "Settings", exact: true }).click();
      await peer.getByLabel("Dark", { exact: true }).check();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await peer.reload();
      await expect(peer.locator("html")).toHaveAttribute("data-theme", "dark");
      await peer.getByRole("button", { name: "Settings", exact: true }).click();
      await peer.getByLabel("System", { exact: true }).check();
      await expect(page.locator("html")).not.toHaveAttribute("data-theme");
      await peer.close();
      // Crossing the breakpoint closes the drawer and keeps the same canvas.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: "Toggle navigation" }).click();
      await expect(
        page.getByRole("dialog", { name: "Navigation", exact: true }),
      ).toBeVisible();
      await page.setViewportSize({ width, height });
      await expect(page.locator(".app-sidebar")).toBeVisible();
      await expect(page.locator("canvas")).toHaveAttribute(
        "data-original",
        "yes",
      );
      await stable(page, baseline);
    }
    await page.screenshot({
      path: path.join(artifacts, `${name}.png`),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement !== null))
      .toBe(true);
    await page.evaluate(() => window.layoutFixture.unmount());
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement))
      .toBeNull();
    await expect(page.locator(".remote-viewer")).toHaveCount(0);
    assert.deepEqual(errors, []);
    results.push({
      name,
      width,
      height,
      stableGeometry: true,
      unchangedScroll: true,
      singleStatus: true,
      fullscreen: ["native", "unsupported", "rejected"],
      fullscreenLabels: true,
      fullscreenUnmount: true,
      errors,
    });
    console.log(
      `${name}: lock/unlock, messages, permission loss, rotation and dialogs keep geometry and scroll stable`,
    );
    await context.close();
  }
  // The actual React switch must remain usable while Android consent is pending.
  for (const width of [1280, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
    });
    const page = await context.newPage();
    activePage = page;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `http://127.0.0.1:${address.port}/layout-proof?locked=false&savedPin=false`,
    );
    const toggle = page.getByRole("switch", {
      name: "Smooth view",
      exact: true,
    });
    await expect(toggle).toBeEnabled();
    const baseline = await geometry(page);
    for (const reason of [
      "canceled",
      "interrupted",
      "locked",
      "disconnected",
      "permission",
      "timeout",
    ] as const) {
      await toggle.click();
      await expect(page.getByRole("status")).toContainText(
        "Approve screen sharing",
      );
      await expect(toggle).toHaveAttribute("aria-busy", "true");
      await expect(toggle).not.toBeChecked();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await stable(page, baseline);
      const sent = await page.evaluate(
        () => window.layoutFixture.videos.length,
      );
      await page.evaluate(
        (reason) =>
          window.layoutFixture.patch({
            video: { id: 1, phase: "off", reason },
          }),
        reason,
      );
      await expect(toggle).toHaveAttribute("aria-busy", "false");
      await expect(toggle).not.toBeChecked();
      await expect(toggle).toBeEnabled();
      await page.waitForTimeout(1700);
      assert.equal(
        await page.evaluate(() => window.layoutFixture.videos.length),
        sent,
        "Polling never reopens consent",
      );
    }
    await toggle.click();
    await expect(page.getByRole("status")).toContainText(
      "Approve screen sharing",
    );
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-busy", "false");
    await expect
      .poll(() => page.evaluate(() => window.layoutFixture.videos.at(-1)))
      .toBe(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await stable(page, baseline);
    // A host reporting active is insufficient until the decoder displays a frame.
    await toggle.click();
    await expect(page.getByRole("status")).toContainText(
      "Approve screen sharing",
    );
    await page.evaluate(() =>
      window.layoutFixture.patch({
        video: { id: 2, phase: "active", reason: "none" },
      }),
    );
    await expect(page.getByRole("status")).toContainText(
      "Starting smooth view",
    );
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-busy", "false");
    // The current internal-beta host remains useful for still frames before updating.
    await page.evaluate(() => window.layoutFixture.legacyVideo());
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute(
      "title",
      "Update the phone app to use Smooth view.",
    );
    await stable(page, baseline);
    await page.screenshot({
      path: path.join(artifacts, `smooth-${width}.png`),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    results.push({
      smoothView: width,
      noModal: true,
      cancellationAndRetry: true,
      errors,
    });
    await context.close();
  }
  // Exercise the actual React unlock flow, including StrictMode effect replay,
  // persisted uncertainty across reloads and native recovery state.
  for (const scenario of [
    "deferred",
    "unavailable",
    "failed",
    "lost",
    "disconnected",
    "no-pin",
    "not-allowed",
    "no-accessibility",
    "blocked",
    "unlocked",
    "no-storage",
  ] as const) {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    if (scenario === "no-storage")
      await context.addInitScript(() => {
        Storage.prototype.setItem = () => {
          throw Error("Storage unavailable");
        };
      });
    const page: Page = await context.newPage();
    activePage = page;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const query = new URLSearchParams({ unlock: scenario });
    if (scenario === "no-pin") query.set("savedPin", "false");
    if (scenario === "not-allowed") query.set("unlockAllowed", "false");
    if (scenario === "no-accessibility") query.set("accessibility", "false");
    if (scenario === "blocked") query.set("unlockBlocked", "true");
    if (scenario === "unlocked") query.set("locked", "false");
    await page.goto(`http://127.0.0.1:${address.port}/layout-proof?${query}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Test phone",
    );
    const baseline = await geometry(page);
    const calls = () => page.evaluate(() => window.layoutFixture.unlocks);
    if (scenario === "deferred") {
      await expect(page.getByRole("status")).toHaveText(
        "Unlocking with saved PIN…",
      );
      await expect(page.getByLabel("Phone PIN", { exact: true })).toBeHidden();
      await expect.poll(calls).toEqual(["unlockSaved"]);
      await page.evaluate(() => window.layoutFixture.finishUnlock());
      await expect(page.locator(".screen-overlay")).toBeHidden();
      await expect
        .poll(() =>
          page.evaluate(() =>
            localStorage.getItem(`yepcontrol-unlock-attempt:${"a".repeat(64)}`),
          ),
        )
        .toBeNull();
    } else if (
      ["unavailable", "failed", "lost", "disconnected"].includes(scenario)
    ) {
      const expected =
        scenario === "unavailable"
          ? "Couldn’t enter the saved PIN."
          : scenario === "failed"
            ? "We couldn’t unlock the phone using the saved PIN."
            : "Couldn’t confirm whether the phone unlocked.";
      await expect(page.getByRole("status")).toContainText(expected);
      await expect(page.locator(".screen-panel")).toContainText(expected);
      await expect.poll(calls).toEqual(["unlockSaved"]);
      if (scenario === "disconnected")
        await expect
          .poll(() => page.evaluate(() => window.layoutFixture.ended))
          .toContain("Couldn’t confirm whether the phone unlocked");
      if (scenario === "failed") {
        await expect(
          page.getByRole("button", { name: "Unlock phone", exact: true }),
        ).toBeDisabled();
        await expect(
          page.getByRole("button", { name: "Use saved PIN", exact: true }),
        ).toHaveCount(0);
        await expect(page.locator(".screen-panel")).toContainText(
          "Unlock the phone locally",
        );
      } else {
        await expect(
          page.getByRole("button", { name: "Unlock phone", exact: true }),
        ).toBeEnabled();
      }
      await stable(page, baseline);
      await page.screenshot({
        path: path.join(artifacts, `unlock-${scenario}.png`),
      });
      await page.reload();
      await expect(page.getByRole("status")).toContainText(
        "It was not retried automatically",
      );
      assert.deepEqual(
        await calls(),
        [],
        "Reload must not replay an unsuccessful or uncertain unlock",
      );
      if (scenario === "unavailable") {
        await page.getByLabel("Phone PIN", { exact: true }).fill("1234");
        await page
          .getByRole("button", { name: "Unlock phone", exact: true })
          .click();
        await expect(page.locator(".screen-overlay")).toBeHidden();
        assert.deepEqual(
          await calls(),
          ["unlock"],
          "Pre-entry failure permits an explicit manual attempt",
        );
        await expect
          .poll(() =>
            page.evaluate(() =>
              localStorage.getItem(
                `yepcontrol-unlock-attempt:${"a".repeat(64)}`,
              ),
            ),
          )
          .toBeNull();
      }
    } else {
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.layoutFixture.trace.filter((op) =>
                op.startsWith("status:"),
              ).length,
          ),
        )
        .toBeGreaterThan(2);
      assert.deepEqual(
        await calls(),
        [],
        "Automatic unlock requires saved PIN, permission, screen access, locked state and a clear guard",
      );
      if (scenario === "no-pin")
        await expect(
          page.getByLabel("Phone PIN", { exact: true }),
        ).toBeVisible();
      if (scenario === "no-storage") {
        await expect(page.getByRole("status")).toContainText(
          "this browser couldn’t save the attempt",
        );
        await page
          .getByRole("button", { name: "Use saved PIN", exact: true })
          .click();
        await expect(page.locator(".screen-overlay")).toBeHidden();
        assert.deepEqual(
          await calls(),
          ["unlockSaved"],
          "Unavailable browser storage still permits an explicit unlock protected by the native guard",
        );
      }
    }
    await stable(page, baseline);
    assert.deepEqual(errors, []);
    results.push({ unlockScenario: scenario, errors });
    console.log(
      `unlock ${scenario}: automatic attempt and recovery checks passed`,
    );
    await context.close();
  }
  await writeFile(
    path.join(artifacts, "result.json"),
    JSON.stringify(results, null, 2),
    { mode: 0o600 },
  );
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage
      .screenshot({ path: path.join(artifacts, "failure.png") })
      .catch(() => {});
    const diagnostic = await activePage
      .evaluate(() => ({
        status: document.querySelector("[role=status]")?.textContent,
        trace: window.layoutFixture?.trace,
      }))
      .catch(() => undefined);
    console.error("Layout failure:", JSON.stringify(diagnostic));
  }
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
