import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { createServer } from "vite";
import { type DeviceInfo, sealDevice } from "../protocol/src/device.js";
import {
  decodeInvitation,
  type Grant,
  grantBytes,
  grantMac,
  hex,
  verifySignature,
} from "../protocol/src/enrollment.js";
import { b64, createIdentity } from "../protocol/src/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(root, ".local/viewer-phones-proof");
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const key = path.join(artifacts, "fixture-key.pem");
const cert = path.join(artifacts, "fixture-cert.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-keyout",
    key,
    "-out",
    cert,
  ],
  { stdio: "ignore" },
);
const first = await createIdentity();
const second = await createIdentity();
const models = {
  [b64(first.publicKey)]: "Pixel 9",
  [b64(second.publicKey)]: "Pixel 7a",
};
const server = await createServer({
  configFile: false,
  root: path.join(root, "web"),
  logLevel: "error",
  server: {
    host: "127.0.0.1",
    port: 0,
    fs: { allow: [root] },
    https: { key: await readFile(key), cert: await readFile(cert) },
  },
  plugins: [
    {
      name: "phones-proof",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url?.startsWith("/api/pair/")) {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ state: "pending" }));
            return;
          }
          if (req.url === "/fixture-models") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(models));
            return;
          }
          if (req.url === "/fixture-bootstrap") {
            res.setHeader("Content-Type", "text/html");
            res.end("<!doctype html><title>Fixture bootstrap</title>");
            return;
          }
          if (
            req.url === "/" ||
            req.url === "/phones" ||
            req.url === "/pair" ||
            req.url?.startsWith("/phones/")
          ) {
            res.setHeader("Content-Type", "text/html");
            res.end(
              `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><script src="/appearance.js"></script></head><body><div id="root"></div><script type="module" src="/@fs/${path.join(root, "web/test/phones-fixture.tsx")}"></script></body></html>`,
            );
            return;
          }
          next();
        });
      },
    },
  ],
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function records(page: Page) {
  return page.evaluate(async () => {
    const module = "/src/store.ts";
    return (await import(module)).savedPhones() as Promise<
      {
        id: string;
        alias?: string;
        device: DeviceInfo;
        lastContactAt?: number;
        grant: Grant;
      }[]
    >;
  });
}
async function rename(page: Page, name: string, alias: string) {
  await page
    .getByRole("button", { name: `Rename ${name}`, exact: true })
    .click();
  const input = page.getByLabel("Phone name", { exact: true });
  await input.fill("");
  await input.pressSequentially(alias, { delay: 12 });
  await expect(input).toHaveValue(alias);
  await input.press("Enter");
  await expect(input).toBeHidden();
}
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string")
    throw Error("Missing fixture address");
  const origin = `https://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  const errors: string[] = [];
  context.on("page", (page) =>
    page.on("pageerror", (error) => errors.push(error.message)),
  );
  const home = await context.newPage();
  await home.goto(`${origin}/fixture-bootstrap`);
  // Seed the current format through the real store; legacy formats intentionally reset.
  const seeded = await home.evaluate(async (phone) => {
    const module = "/src/store.ts";
    const store = await import(module);
    const identity = await store.browserIdentity();
    const viewer = btoa(String.fromCharCode(...identity.publicKey));
    const grant: Grant = {
      id: "a".repeat(32),
      phone,
      viewer,
      expires: 1,
      mac: "fixture",
      phoneSignature: "fixture",
      viewerSignature: "fixture",
    };
    await store.rememberPhone(grant, {
      manufacturer: "Google",
      model: "Pixel 9",
      name: "Pixel 9",
      android: "17",
      sdk: 37,
      app: "0.8.0",
      connectionPreparation: 1,
    });
    return grant;
  }, b64(first.publicKey));
  const other = await context.newPage();
  await Promise.all([home.goto(origin), other.goto(origin)]);
  await expect(
    home
      .locator(".phone-list")
      .getByRole("link", { name: "Pixel 9", exact: true }),
  ).toBeVisible();
  const stored = await records(home);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0]?.grant, seeded);
  const firstId = stored[0]?.id;
  assert.ok(firstId);
  const keyPreserved = await home.evaluate(async (viewer) => {
    const module = "/src/store.ts";
    const identity = await (await import(module)).browserIdentity();
    return btoa(String.fromCharCode(...identity.publicKey)) === viewer;
  }, seeded.viewer);
  assert.equal(keyPreserved, true);
  console.log("Concurrent tabs preserved the current pairing and browser key");
  const a = await context.newPage();
  await a.goto(`${origin}/phones/${firstId}`);
  await expect(a.getByRole("status")).toHaveText("Ready to connect");
  await expect(a.getByRole("region", { name: "Phone preview" })).toBeVisible();
  assert.equal(await a.evaluate(() => window.phonesFixture.checks), 1);
  await a
    .getByRole("button", { name: "Connect to phone", exact: true })
    .click();
  await expect(a.getByRole("region", { name: "Remote screen" })).toBeVisible();
  await expect(
    home.getByRole("link", { name: "Pixel 9", exact: true }),
  ).toBeVisible();
  await expect(home.locator("time")).toHaveCount(1);
  await a.getByRole("button", { name: "Disconnect", exact: true }).click();
  // Opening a phone checks once, refreshes contact history only on success,
  // and keeps preview/live/disconnected frame geometry identical.
  const beforeFailure = (await records(a))[0]?.lastContactAt;
  await a.evaluate(() => sessionStorage.setItem("fixture-fail", "true"));
  await a.reload();
  await expect(a.getByRole("status")).toHaveText(
    "Fixture phone is unavailable",
  );
  assert.equal((await records(a))[0]?.lastContactAt, beforeFailure);
  await a.evaluate(() => sessionStorage.removeItem("fixture-fail"));
  await a.reload();
  await expect(a.getByRole("status")).toHaveText("Ready to connect");
  await expect
    .poll(async () => (await records(a))[0]?.lastContactAt ?? 0)
    .toBeGreaterThan(beforeFailure ?? 0);
  assert.equal(
    await a
      .getByRole("button", { name: "Check connection", exact: true })
      .count(),
    0,
  );
  assert.deepEqual(
    await a.evaluate(() => ({
      checks: window.phonesFixture.checks,
      controls: window.phonesFixture.controls,
    })),
    { checks: 1, controls: 0 },
  );
  async function frame(page: Page) {
    return page
      .locator(".screen-stage, .control-dock")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const r = element.getBoundingClientRect();
          // The live dock adds Smooth viewing; its height may grow, while the
          // phone frame and the dock's position/width must remain fixed.
          return {
            x: r.x,
            y: r.y,
            width: r.width,
            ...(element.matches(".screen-stage") ? { height: r.height } : {}),
          };
        }),
      );
  }
  for (const [name, width, height] of [
    ["desktop", 1280, 1000],
    ["mobile", 390, 844],
    ["small-mobile", 320, 680],
    ["landscape", 844, 390],
  ] as const) {
    await a.setViewportSize({ width, height });
    const previewFrame = await frame(a);
    await expect(
      a.getByRole("region", { name: "Phone features" }),
    ).toBeVisible();
    await expect(
      a.getByRole("img", { name: "Screen viewing: Enabled", exact: true }),
    ).toBeVisible();
    assert.equal(await a.locator(".phone-preview details").count(), 0);
    await a.screenshot({ path: path.join(artifacts, `${name}-preview.png`) });
    await a
      .getByRole("button", { name: "Connect to phone", exact: true })
      .click();
    await expect(
      a.getByRole("region", { name: "Remote screen" }),
    ).toBeVisible();
    assert.deepEqual(await frame(a), previewFrame);
    await a.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(
      a.getByRole("region", { name: "Phone preview" }),
    ).toBeVisible();
    assert.deepEqual(await frame(a), previewFrame);
  }
  await a.setViewportSize({ width: 1280, height: 1000 });
  // The centered card, not just its outer screen frame, must remain fixed as
  // requests, contact history and capability reports arrive or fail.
  const states = await context.newPage();
  await states.goto(`${origin}/fixture-bootstrap`);
  await states.evaluate(() => {
    sessionStorage.setItem("fixture-delay", "true");
    sessionStorage.setItem("fixture-control-delay", "true");
  });
  async function previewGeometry() {
    return states.evaluate(() => ({
      boxes: Array.from(
        document.querySelectorAll(
          ".screen-stage, .control-dock, .connect-panel, .connect-panel > button, .contact-detail, .preview-features, .capability",
        ),
      ).map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
      scroll: [
        scrollX,
        scrollY,
        document.querySelector(".preview-overlay")?.scrollTop,
      ],
    }));
  }
  async function recheck() {
    const before = await states.evaluate(() => window.phonesFixture.checks);
    await states.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pageshow", { persisted: true }),
      ),
    );
    await expect
      .poll(() => states.evaluate(() => window.phonesFixture.checks))
      .toBe(before + 1);
  }
  for (const [name, width, height] of [
    ["desktop", 1280, 1000],
    ["mobile", 390, 844],
    ["small-mobile", 320, 680],
    ["landscape", 844, 390],
  ] as const) {
    await states.setViewportSize({ width, height });
    await states.goto(a.url());
    await expect
      .poll(() => states.evaluate(() => window.phonesFixture?.checks ?? 0))
      .toBe(1);
    await expect(
      states.getByRole("img", { name: /Status unknown/ }),
    ).toHaveCount(3);
    const baseline = await previewGeometry();
    await states.evaluate(() => {
      window.phonesFixture.features = {
        type: "features",
        v: 1,
        screenViewing: "permission-needed",
        touchControl: "unavailable",
        connectionRequests: "notifications-needed",
        device: {
          manufacturer: "Google",
          model: "Pixel 9",
          name: "Fixture phone",
          android: "17",
          sdk: 37,
          app: "0.8.0",
          connectionPreparation: 1,
        },
      };
      window.phonesFixture.finishCheck();
    });
    await expect(states.getByRole("status")).toHaveText("Ready to connect");
    await expect(
      states.getByRole("img", { name: /Screen viewing: Off/ }),
    ).toBeVisible();
    await expect(
      states.getByRole("img", { name: /Touch control: Unavailable/ }),
    ).toBeVisible();
    await expect(
      states.getByRole("img", {
        name: /Connection requests: Enable notifications/,
      }),
    ).toBeVisible();
    assert.deepEqual(await previewGeometry(), baseline);
    await states.screenshot({
      path: path.join(artifacts, `${name}-capabilities-off.png`),
    });
    await recheck();
    assert.deepEqual(await previewGeometry(), baseline);
    await states.evaluate(() => {
      window.phonesFixture.fail = true;
      window.phonesFixture.finishCheck();
    });
    await expect(states.getByRole("status")).toHaveText(
      "Fixture phone is unavailable",
    );
    assert.deepEqual(await previewGeometry(), baseline);
    await states
      .getByRole("button", { name: "Connect to phone", exact: true })
      .click();
    await expect
      .poll(() => states.evaluate(() => window.phonesFixture.controls))
      .toBe(1);
    await expect(
      states.getByRole("button", { name: "Connect to phone", exact: true }),
    ).toHaveText("Connecting…");
    assert.deepEqual(await previewGeometry(), baseline);
    await states
      .getByRole("button", { name: "Cancel connection", exact: true })
      .click();
    await expect(states.getByRole("status")).toHaveText("Connection cancelled");
    assert.deepEqual(await previewGeometry(), baseline);
    await states
      .getByRole("button", { name: "Connect to phone", exact: true })
      .click();
    await expect
      .poll(() => states.evaluate(() => window.phonesFixture.controls))
      .toBe(2);
    await states.evaluate(() => window.phonesFixture.finishControl());
    await expect(states.getByRole("status")).toHaveText(
      "Fixture phone is unavailable",
    );
    assert.deepEqual(await previewGeometry(), baseline);
    await recheck();
    await states.evaluate(() => {
      window.phonesFixture.fail = false;
      window.phonesFixture.features = {
        type: "features",
        v: 1,
        screenViewing: "enabled",
        touchControl: "enabled",
        connectionRequests: "enabled",
        device: {
          manufacturer: "Google",
          model: "Pixel 9",
          name: "Fixture phone",
          android: "17",
          sdk: 37,
          app: "0.8.0",
          connectionPreparation: 1,
        },
      };
      window.phonesFixture.finishCheck();
    });
    await expect(states.getByRole("status")).toHaveText("Ready to connect");
    await expect(states.getByRole("img", { name: /: Enabled$/ })).toHaveCount(
      3,
    );
    assert.deepEqual(await previewGeometry(), baseline);
    await states.emulateMedia({ colorScheme: "dark" });
    assert.deepEqual(await previewGeometry(), baseline);
    await states.screenshot({
      path: path.join(artifacts, `${name}-capabilities-dark.png`),
    });
    await states.emulateMedia({ colorScheme: "light" });
  }
  await states.close();
  await a.bringToFront();
  await expect
    .poll(() =>
      a.evaluate(
        async (id) =>
          (await navigator.locks.query()).held?.some(
            (lock) => lock.name === `remote-access-phone:${id}`,
          ) ?? false,
        firstId,
      ),
    )
    .toBe(false);
  console.log(
    "Preview card and capability icons stay fixed through loading, errors, cancellation and theme changes at four sizes",
  );
  assert.equal(
    await a.evaluate(() => window.phonesFixture.checks),
    1,
    "Disconnect does not wake/check the phone again",
  );
  await rename(home, "Pixel 9", "RV phone");
  await expect(a.getByRole("heading", { level: 1 })).toHaveText("RV phone");
  await expect(a).toHaveTitle("RV phone · YepControl");
  assert.equal(await a.evaluate(() => window.phonesFixture.checks), 1);
  // Exercise the persisted-pageshow lifecycle without depending on Chromium's
  // cache admission for a dev server page with open development sockets.
  await a.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect
    .poll(() => a.evaluate(() => window.phonesFixture.checks))
    .toBe(2);
  await expect(a.getByRole("status")).toHaveText("Ready to connect");
  // Pair another phone through the real QR/signature/receipt UI.
  const offered = new Map<string, Grant>();
  const deviceOffers = new Map<string, string>();
  const completed = new Set<string>();
  const lostReceipts = new Set<string>();
  await context.route("**/api/pair/**", async (route) => {
    const request = route.request();
    const parts = new URL(request.url()).pathname.split("/");
    const id = parts[3] ?? "";
    if (parts[4] === "complete") {
      const grant = offered.get(id);
      assert.ok(grant);
      const body = request.postDataJSON() as { viewerSignature: string };
      await verifySignature(
        grant.viewer,
        grantBytes(origin, grant),
        body.viewerSignature,
      );
      completed.add(id);
      if (lostReceipts.has(id)) {
        // Simulate a committed pairing whose reply is lost as the QR expires.
        await request
          .frame()
          .page()
          .evaluate((expires) => {
            Date.now = () => expires * 1000 + 1;
          }, grant.expires);
        await route.abort("connectionreset");
        return;
      }
      await route.fulfill({ json: { state: "paired" } });
    } else
      await route.fulfill({
        json: offered.has(id)
          ? {
              state: "offered",
              grant: offered.get(id),
              device: deviceOffers.get(id),
            }
          : { state: "pending" },
      });
  });
  await other
    .getByRole("link", { name: "Control a phone", exact: true })
    .click();
  await expect(
    other.getByText(/Pairing adds access\. Earlier pairings/),
  ).toHaveCount(0);
  const qr = PNG.sync.read(
    await other
      .getByRole("img", { name: "Scan to pair this browser" })
      .screenshot(),
  );
  const decoded = jsQR(new Uint8ClampedArray(qr.data), qr.width, qr.height);
  assert.ok(decoded);
  const invitation = decodeInvitation(decoded.data);
  const grant: Grant = {
    id: invitation.id,
    viewer: invitation.viewer,
    phone: b64(second.publicKey),
    expires: invitation.expires,
    phoneSignature: "",
    mac: "",
  };
  const bytes = grantBytes(origin, grant);
  grant.phoneSignature = b64(await second.sign(bytes));
  grant.mac = hex(await grantMac(invitation.secret, bytes));
  deviceOffers.set(
    grant.id,
    await sealDevice(invitation.secret, invitation.id, {
      manufacturer: "Google",
      model: "Pixel 7a",
      name: "Pixel 7a",
      android: "17",
      sdk: 37,
      app: "0.8.0",
      connectionPreparation: 1,
    }),
  );
  offered.set(grant.id, grant);
  await expect(other).toHaveURL(/\/phones\/[a-f0-9]{64}$/);
  const both = await records(home);
  assert.equal(both.length, 2);
  const secondId = both.find((phone) => phone.grant.phone === grant.phone)?.id;
  assert.ok(secondId);
  const secondDevice = both.find((phone) => phone.id === secondId)?.device;
  assert.ok(secondDevice);
  assert.equal(both.find((phone) => phone.id === firstId)?.alias, "RV phone");
  console.log("Pairing a second phone preserved the first phone and its alias");

  const interrupted = await context.newPage();
  await interrupted.setViewportSize({ width: 320, height: 680 });
  await interrupted.goto(`${origin}/pair`);
  await expect(
    interrupted.getByRole("img", { name: "Scan to pair this browser" }),
  ).toBeVisible();
  await interrupted.screenshot({
    path: path.join(artifacts, "sg5-add-access-mobile.png"),
    fullPage: true,
  });
  const lostQr = PNG.sync.read(
    await interrupted
      .getByRole("img", { name: "Scan to pair this browser" })
      .screenshot(),
  );
  const lostCode = jsQR(
    new Uint8ClampedArray(lostQr.data),
    lostQr.width,
    lostQr.height,
  );
  assert.ok(lostCode);
  const lostInvitation = decodeInvitation(lostCode.data);
  const lostGrant: Grant = {
    ...grant,
    id: lostInvitation.id,
    viewer: lostInvitation.viewer,
    expires: lostInvitation.expires,
    phoneSignature: "",
    mac: "",
  };
  const lostBytes = grantBytes(origin, lostGrant);
  lostGrant.phoneSignature = b64(await second.sign(lostBytes));
  lostGrant.mac = hex(await grantMac(lostInvitation.secret, lostBytes));
  lostReceipts.add(lostGrant.id);
  deviceOffers.set(
    lostGrant.id,
    await sealDevice(lostInvitation.secret, lostInvitation.id, secondDevice),
  );
  offered.set(lostGrant.id, lostGrant);
  await expect(interrupted.getByRole("status")).toHaveText(
    "Pairing could not be confirmed.",
  );
  await expect(interrupted.getByRole("alert")).toHaveText(
    "Check YepControl on the phone for an added browser before trying again.",
  );
  await expect(
    interrupted.getByRole("button", { name: "New code", exact: true }),
  ).toBeVisible();
  await expect(
    interrupted.getByRole("img", { name: "Scan to pair this browser" }),
  ).toHaveCount(0);
  assert.ok(completed.has(lostGrant.id));
  assert.equal(
    (await records(home)).find((phone) => phone.id === secondId)?.grant.id,
    grant.id,
  );
  assert.equal(
    await interrupted.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await interrupted.screenshot({
    path: path.join(artifacts, "sg5-unconfirmed-mobile.png"),
    fullPage: true,
  });
  await interrupted.close();
  console.log(
    "A lost completion receipt preserves saved access and explains manual cleanup without renewing the QR",
  );
  await other
    .getByRole("button", { name: "Connect to phone", exact: true })
    .click();
  await a
    .getByRole("button", { name: "Connect to phone", exact: true })
    .click();
  await expect(
    other.getByRole("region", { name: "Remote screen" }),
  ).toBeVisible();
  await expect(a.getByRole("region", { name: "Remote screen" })).toBeVisible();
  await expect(other.getByRole("heading", { level: 1 })).toHaveText("Pixel 7a");
  await expect(a.getByRole("heading", { level: 1 })).toHaveText("RV phone");
  assert.deepEqual(
    await a.evaluate(() => window.phonesFixture.calls.slice(-1)),
    [seeded.id],
  );
  assert.equal(await other.evaluate(() => window.phonesFixture.controls), 1);
  assert.ok(
    await other.evaluate(
      (id) => window.phonesFixture.calls.every((call) => call === id),
      grant.id,
    ),
  );
  // The sidebar observes live leases held in this and other tabs, without
  // inventing a global online status or making a connection request.
  await home.bringToFront();
  for (const name of ["RV phone", "Pixel 7a"]) {
    await expect(
      home.getByRole("link", { name: `Switch to ${name}`, exact: true }),
    ).toContainText("In use");
  }
  const liveBefore = await other.evaluate(() => ({
    calls: [...window.phonesFixture.calls],
    closed: window.phonesFixture.closed,
  }));
  await other.getByRole("button", { name: "Settings", exact: true }).click();
  await other.getByLabel("Dark", { exact: true }).check();
  await expect(home.locator("html")).toHaveAttribute("data-theme", "dark");
  await other.getByRole("button", { name: "Close settings" }).click();
  assert.deepEqual(
    await other.evaluate(() => ({
      calls: [...window.phonesFixture.calls],
      closed: window.phonesFixture.closed,
    })),
    liveBefore,
    "Opening settings and changing appearance keeps the live session",
  );
  const competing = await context.newPage();
  await competing.goto(a.url());
  await competing
    .getByRole("button", { name: "Connect to phone", exact: true })
    .click();
  await expect(competing.getByRole("status")).toContainText(
    "already in use in another tab",
  );
  assert.deepEqual(
    await competing.evaluate(() => window.phonesFixture.calls),
    [],
  );
  await a.getByRole("button", { name: "Disconnect", exact: true }).click();
  await home.bringToFront();
  await expect(
    home.getByRole("link", { name: "Switch to RV phone", exact: true }),
  ).not.toContainText("In use");
  await expect(
    home.getByRole("link", { name: "Switch to Pixel 7a", exact: true }),
  ).toContainText("In use");
  await competing
    .getByRole("button", { name: "Connect to phone", exact: true })
    .click();
  await expect(
    competing.getByRole("region", { name: "Remote screen" }),
  ).toBeVisible();
  await competing
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  console.log(
    "Two phones connected independently; same-phone contention sent no extra request",
  );
  // Cancel closes a preparation; Connect continues an in-flight preparation.
  await a.evaluate(() => sessionStorage.setItem("fixture-delay", "true"));
  await a.reload();
  await expect
    .poll(() => a.evaluate(() => window.phonesFixture?.checks ?? 0))
    .toBe(1);
  await a
    .getByRole("button", { name: "Cancel connection", exact: true })
    .click();
  await expect(a.getByRole("status")).toHaveText("Connection cancelled");
  await a.evaluate(() => {
    window.phonesFixture.delay = false;
  });
  await a
    .getByRole("button", { name: "Connect to phone", exact: true })
    .click();
  await expect(a.getByRole("region", { name: "Remote screen" })).toBeVisible();
  await a.getByRole("button", { name: "Disconnect", exact: true }).click();
  await a.reload();
  await expect
    .poll(() => a.evaluate(() => window.phonesFixture?.checks ?? 0))
    .toBe(1);
  await a
    .getByRole("button", { name: "Connect to phone", exact: true })
    .click();
  assert.equal(await a.evaluate(() => window.phonesFixture.controls), 0);
  await a.evaluate(() => window.phonesFixture.finishCheck());
  await expect(a.getByRole("region", { name: "Remote screen" })).toBeVisible();
  await expect(a.getByRole("status")).toHaveText("Connected securely");
  assert.deepEqual(
    await a.evaluate(() => ({
      checks: window.phonesFixture.checks,
      controls: window.phonesFixture.controls,
    })),
    { checks: 1, controls: 1 },
  );
  await a.evaluate(() => sessionStorage.removeItem("fixture-delay"));
  await a.evaluate(() => window.phonesFixture.drop());
  await expect(a.getByRole("region", { name: "Phone preview" })).toBeVisible();
  await expect(a.getByRole("status")).toHaveText("Connection ended");
  assert.equal(await a.evaluate(() => window.phonesFixture.checks), 1);
  await a
    .getByRole("button", { name: "Connect to phone", exact: true })
    .click();
  await expect(a.getByRole("region", { name: "Remote screen" })).toBeVisible();
  // Concurrent transactions edit different fields of the same record.
  await Promise.all([
    home.evaluate(async (id) => {
      const module = "/src/store.ts";
      await (await import(module)).renamePhone(id, "Travel phone");
    }, firstId),
    other.evaluate(async (id) => {
      const module = "/src/store.ts";
      await (await import(module)).contactedPhone(id, {
        manufacturer: "Google",
        model: "Pixel 9",
        name: "Pixel 9",
        android: "17",
        sdk: 37,
        app: "0.8.0",
        connectionPreparation: 1,
      });
    }, firstId),
  ]);
  await expect(a.getByRole("heading", { level: 1 })).toHaveText("Travel phone");
  const updated = (await records(home)).find((phone) => phone.id === firstId);
  assert.equal(updated?.alias, "Travel phone");
  assert.equal(updated?.device.model, "Pixel 9");
  assert.ok(updated.lastContactAt);
  await home.reload();
  await expect(
    home
      .locator(".phone-list")
      .getByRole("link", { name: "Travel phone", exact: true }),
  ).toBeVisible();
  await other.reload();
  await expect(other).toHaveURL(`${origin}/phones/${secondId}`);
  await expect(other.getByRole("heading", { level: 1 })).toHaveText("Pixel 7a");
  // Unknown URLs never select a different saved phone or send a request.
  await competing.goto(`${origin}/phones/${"0".repeat(64)}`);
  await expect(competing.getByRole("heading", { level: 1 })).toHaveText(
    "Phone not saved",
  );
  assert.deepEqual(
    await competing.evaluate(() => window.phonesFixture.calls),
    [],
  );
  // A fresh browser cannot use the URL as an authorization token.
  const fresh = await browser.newContext({ ignoreHTTPSErrors: true });
  const unpaired = await fresh.newPage();
  await unpaired.goto(`${origin}/phones/${secondId}`);
  await expect(unpaired.getByRole("heading", { level: 1 })).toHaveText(
    "Phone not saved",
  );
  assert.deepEqual(
    await unpaired.evaluate(() => window.phonesFixture.calls),
    [],
  );
  await fresh.close();
  // Another pairing updates this browser's entry without claiming to revoke earlier access.
  const repaired = await home.evaluate(async (id) => {
    const module = "/src/store.ts";
    const store = await import(module);
    const existing = (await store.savedPhones()).find(
      (phone: { id: string }) => phone.id === id,
    );
    await store.rememberPhone(
      { ...existing.grant, id: "b".repeat(32) },
      existing.device,
    );
    return store.savedPhones() as Promise<
      { id: string; alias?: string; lastContactAt?: number; grant: Grant }[]
    >;
  }, firstId);
  assert.equal(repaired.length, 2);
  assert.equal(
    repaired.find((phone) => phone.id === firstId)?.alias,
    "Travel phone",
  );
  assert.equal(
    repaired.find((phone) => phone.id === firstId)?.grant.id,
    "b".repeat(32),
  );
  assert.ok(repaired.find((phone) => phone.id === firstId)?.lastContactAt);
  await expect(
    a.getByRole("button", { name: "Connect to phone", exact: true }),
  ).toBeVisible();
  await a
    .getByRole("button", { name: "Connect to phone", exact: true })
    .click();
  await a.evaluate(() => window.phonesFixture.finishCheck());
  await expect(a.getByRole("region", { name: "Remote screen" })).toBeVisible();
  for (const [name, width, height] of [
    ["desktop", 1280, 1000],
    ["mobile", 390, 844],
    ["small-mobile", 320, 680],
  ] as const) {
    await home.setViewportSize({ width, height });
    assert.equal(
      await home.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await home.screenshot({
      path: path.join(artifacts, `${name}-two-phones.png`),
      fullPage: true,
    });
  }
  const beforeForget = await a.evaluate(() => window.phonesFixture.closed);
  await home
    .getByRole("button", { name: "Forget Travel phone", exact: true })
    .click();
  await expect(
    home.getByRole("dialog", { name: "Forget Travel phone?" }),
  ).toContainText("This only removes the entry from this browser.");
  await home
    .getByRole("dialog", { name: "Forget Travel phone?" })
    .getByRole("button", { name: "Forget", exact: true })
    .click();
  await expect(a.getByRole("heading", { level: 1 })).toHaveText(
    "Phone not saved",
  );
  await expect
    .poll(() => a.evaluate(() => window.phonesFixture.closed))
    .toBe(beforeForget + 1);
  const remaining = await records(home);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.id, secondId);
  await other.reload();
  await expect(other.getByRole("status")).toHaveText("Ready to connect");
  console.log(
    "Rename/contact updates, refresh, unknown URLs and cross-tab forgetting passed",
  );
  for (const [name, width, height] of [
    ["desktop", 1280, 1000],
    ["mobile", 390, 844],
    ["small-mobile", 320, 680],
  ] as const) {
    await home.setViewportSize({ width, height });
    assert.equal(
      await home.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await home.screenshot({
      path: path.join(artifacts, `${name}.png`),
      fullPage: true,
    });
  }
  // Preparation expiry releases the tab lease and makes no automatic second
  // request. A subsequent explicit Connect uses the ordinary control path.
  await other
    .getByRole("button", { name: "Cancel connection", exact: true })
    .click();
  await other.evaluate(() =>
    sessionStorage.setItem("fixture-preparation-ms", "350"),
  );
  await other.reload();
  await expect(other.getByRole("status")).toHaveText("Ready to connect");
  await expect(other.getByRole("status")).toHaveText(
    "Connect when you’re ready",
  );
  assert.equal(await other.evaluate(() => window.phonesFixture.checks), 1);
  await other
    .getByRole("button", { name: "Connect to phone", exact: true })
    .click();
  await expect(
    other.getByRole("region", { name: "Remote screen" }),
  ).toBeVisible();
  assert.equal(await other.evaluate(() => window.phonesFixture.reused), 0);
  await other.getByRole("button", { name: "Disconnect", exact: true }).click();
  await other.evaluate(() =>
    sessionStorage.removeItem("fixture-preparation-ms"),
  );
  // Retained readiness is promoted without closing its underlying lane.
  await other.reload();
  await expect(other.getByRole("status")).toHaveText("Ready to connect");
  await other
    .getByRole("button", { name: "Connect to phone", exact: true })
    .click();
  await expect(
    other.getByRole("region", { name: "Remote screen" }),
  ).toBeVisible();
  assert.equal(await other.evaluate(() => window.phonesFixture.reused), 1);
  await other.getByRole("button", { name: "Disconnect", exact: true }).click();
  // Existing public 0.7.0 reports have no preparation extension. Loading the
  // page must not wake them merely to throw away a check before Connect.
  await other.evaluate(async (id) => {
    const module = "/src/store.ts";
    const store = await import(module);
    const phone = (await store.savedPhones()).find(
      (p: { id: string }) => p.id === id,
    );
    const { connectionPreparation: _extension, ...device } = phone.device;
    await store.contactedPhone(id, { ...device, app: "0.7.0" });
  }, secondId);
  await other.reload();
  await expect(other.getByRole("status")).toHaveText(
    "Connect when you’re ready",
  );
  assert.equal(await other.evaluate(() => window.phonesFixture.checks), 0);
  await other
    .getByRole("button", { name: "Connect to phone", exact: true })
    .click();
  await expect(
    other.getByRole("region", { name: "Remote screen" }),
  ).toBeVisible();
  assert.equal(await other.evaluate(() => window.phonesFixture.controls), 1);
  console.log(
    "Preparation reused after readiness and during connection; expiry releases its lease; 0.7.0 has no automatic wake",
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(artifacts, "result.json"),
    JSON.stringify(
      {
        currentStorage: true,
        pairingPreserved: true,
        independentPhones: true,
        samePhoneLease: true,
        cancellation: true,
        sharedMetadata: true,
        deepLinks: true,
        forgetClosesSession: true,
        pairingAddsAccess: true,
        lostPairingReceiptExplained: true,
        responsive: true,
        errors,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await context.close();
} finally {
  await browser?.close();
  await server.close();
  await Promise.all([rm(key, { force: true }), rm(cert, { force: true })]);
}
