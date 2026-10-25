import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, get } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { decodeInvitation } from "../protocol/src/enrollment.js";
import { viewerAssetPath } from "../web/routes.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = path.join(root, ".local/public-site-proof");
await mkdir(artifacts, { recursive: true });
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".xml": "application/xml",
  ".txt": "text/plain",
};
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
const server = createServer(
  { key: await readFile(key), cert: await readFile(cert) },
  async (req, res) => {
    const route = new URL(req.url ?? "/", "http://localhost").pathname;
    if (route.startsWith("/api/")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ state: "waiting" }));
      return;
    }
    const file = path.join(root, "web/dist", viewerAssetPath(route));
    try {
      const bytes = await readFile(file);
      res.setHeader(
        "Content-Type",
        types[path.extname(file)] ?? "application/octet-stream",
      );
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  },
);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw Error("No server address");
const origin = `https://127.0.0.1:${address.port}`;
function html(route: string) {
  return new Promise<string>((resolve, reject) => {
    get(origin + route, { rejectUnauthorized: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    }).on("error", reject);
  });
}
const play = "https://play.google.com/store/apps/details?id=com.yepcontrol.app";
const browser = await chromium.launch({ headless: true });
const errors: string[] = [];
try {
  const raw = await html("/");
  assert.match(raw, /<meta name="description"/);
  assert.match(raw, /Control Your Android Phone from a Browser/);
  assert.match(raw, /schema.org\/WebSite/);
  assert.match(await html("/robots.txt"), /sitemap.xml/);
  assert.match(await html("/sitemap.xml"), /https:\/\/yepcontrol.com\//);
  for (const [name, width, height, theme] of [
    ["mobile-dark", 390, 844, "dark"],
    ["small-mobile-light", 320, 680, "light"],
    ["desktop-light", 1280, 900, "light"],
  ] as const) {
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
      ignoreHTTPSErrors: true,
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "YepControl",
    );
    await expect(page).toHaveTitle(
      "YepControl – Control Your Android Phone from a Browser",
    );
    const install = page.getByRole("link", { name: "Get it on Google Play" });
    await expect(install).toHaveAttribute("href", play);
    await expect(install).toBeInViewport({ ratio: 1 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(artifacts, `${name}-home.png`),
      fullPage: true,
    });
    await page
      .getByRole("link", { name: "Control a phone", exact: true })
      .click();
    await expect(page.locator(".pairing-code svg")).toBeVisible();
    const png = PNG.sync.read(
      await page.locator(".pairing-code svg").screenshot(),
    );
    const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert.ok(code, "Rendered pairing QR decodes");
    const invitation = decodeInvitation(code.data);
    assert.equal(invitation.origin, origin);
    assert.equal(new URL(code.data).pathname, "/enroll");
    // Exercise the real UI against a private clipboard fixture, never the user's clipboard.
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          async writeText(value: string) {
            document.documentElement.dataset.copiedPairing = value;
          },
        },
      });
    });
    await page
      .getByRole("button", { name: "Copy pairing link instead" })
      .click();
    const copied = await page.evaluate(
      () => document.documentElement.dataset.copiedPairing,
    );
    assert.ok(copied);
    assert.deepEqual(decodeInvitation(copied), invitation);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          async writeText() {
            throw Error("Fixture clipboard unavailable");
          },
        },
      });
    });
    await page
      .getByRole("button", { name: "Copy pairing link instead" })
      .click();
    await expect(page.getByLabel("Pairing link", { exact: true })).toHaveValue(
      copied,
    );
    await page.screenshot({
      path: path.join(artifacts, `${name}-pair.png`),
      fullPage: true,
    });
    await page.goto(copied);
    await expect.poll(() => new URL(page.url()).hash).toBe("");
    const openApp = page.getByRole("link", {
      name: "Open pairing in YepControl",
      exact: true,
    });
    await expect(openApp).toBeVisible();
    const intent = await openApp.getAttribute("href");
    assert.ok(intent);
    assert.equal(
      intent.split("#Intent;")[0]?.replace(/^intent:/, "https:"),
      copied,
    );
    assert.ok(
      intent.endsWith(`S.browser_fallback_url=${encodeURIComponent(play)};end`),
    );
    await page.goto(`${origin}/enroll#synthetic-install-secret`);
    await expect.poll(() => new URL(page.url()).hash).toBe("");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Get YepControl on your phone",
    );
    await expect(
      page.getByText("For the phone being controlled", { exact: false }),
    ).toBeVisible();
    const link = page.getByRole("link", { name: "Install from Google Play" });
    await expect(link).toHaveAttribute("href", play);
    await expect(link).toBeInViewport({ ratio: 1 });
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex",
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: path.join(artifacts, `${name}-install.png`),
      fullPage: true,
    });
    let headers: Record<string, string> | undefined;
    await page.route("https://play.google.com/**", async (route) => {
      assert.equal(route.request().url(), play);
      headers = await route.request().allHeaders();
      await route.fulfill({ body: "Play fixture", contentType: "text/html" });
    });
    await link.click();
    await expect(page).toHaveURL(play);
    assert.ok(headers);
    assert.equal(
      headers.referer,
      undefined,
      "No scanned invitation or referrer reaches Play",
    );
    await context.close();
  }
  const noJS = await browser.newContext({
    javaScriptEnabled: false,
    ignoreHTTPSErrors: true,
  });
  const staticPage = await noJS.newPage();
  await staticPage.goto(origin);
  await expect(
    staticPage.getByRole("link", { name: "Get it on Google Play" }),
  ).toBeVisible();
  await staticPage.goto(`${origin}/enroll`);
  await expect(
    staticPage.getByRole("link", { name: "Install from Google Play" }),
  ).toBeVisible();
  await noJS.close();
  const returning = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });
  returning.on("pageerror", (error) => errors.push(error.message));
  await returning.goto(origin);
  const fixture = {
    id: "a".repeat(64),
    grant: {
      id: "b".repeat(32),
      phone: "fixture",
      viewer: "fixture",
      expires: 1,
      mac: "fixture",
      phoneSignature: "fixture",
      viewerSignature: "fixture",
    },
    pairedAt: 1,
    deviceAt: 1,
    history: [],
    device: {
      manufacturer: "Google",
      model: "Fixture phone",
      name: "Fixture phone",
      android: "15",
      sdk: 35,
      app: "0.7.0",
    },
  };
  await returning.evaluate(async (record) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("remote-access-v1", 3);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("phones", "readwrite");
        tx.objectStore("phones").put(record);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, fixture);
  await returning.reload();
  await expect(returning.getByRole("heading", { level: 1 })).toHaveText(
    "Your phones",
  );
  await expect(returning.locator("#welcome")).toHaveCount(0);
  await expect(
    returning
      .locator(".phone-list")
      .getByRole("link", { name: "Fixture phone", exact: true }),
  ).toHaveAttribute("href", `/phones/${fixture.id}`);
  await returning
    .getByRole("link", { name: "All phones", exact: true })
    .click();
  await expect(returning).toHaveURL(`${origin}/phones`);
  await expect(returning.getByRole("heading", { level: 1 })).toHaveText(
    "Your phones",
  );
  await expect(returning.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS public HTML/metadata, mobile/desktop layout, QR decoding, install fallback, secret isolation, no-JS links and returning phone navigation",
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
