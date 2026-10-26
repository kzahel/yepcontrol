import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { type Browser, expect } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { sealDevice } from "../protocol/src/device.js";
import {
  decodeInvitation,
  type Grant,
  grantBytes,
  grantMac,
  hex,
  verifySignature,
} from "../protocol/src/enrollment.js";
import { b64, createIdentity } from "../protocol/src/index.js";
import { createRelay } from "../relay/src/server.js";

/** Real signed creation/offer/completion through the built viewer and Node relay. */
export async function verifyPairingClocks(
  browser: Browser,
  origin: string,
  artifacts: string,
) {
  const directory = await mkdtemp(path.join(artifacts, "clock-relay-"));
  const relay = createRelay({ origin, stateDir: directory, pairWaitMs: 100 });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const address = relay.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const offset of [0, 3000, -600000, 600000]) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        ignoreHTTPSErrors: true,
        deviceScaleFactor: 2,
      });
      try {
        await context.addInitScript((skew) => {
          const realNow = Date.now.bind(Date);
          Date.now = () => realNow() + skew;
        }, offset);
        const page = await context.newPage();
        const creates: { id: string; status: number }[] = [];
        await page.route("**/api/pair/**", async (route) => {
          const request = route.request();
          const pathname = new URL(request.url()).pathname;
          const response = await route.fetch({ url: base + pathname });
          if (
            request.method() === "POST" &&
            /^\/api\/pair\/[a-f0-9]{32}$/.test(pathname)
          )
            creates.push({ id: pathname, status: response.status() });
          await route.fulfill({ response });
        });
        await page.goto(`${origin}/pair`);
        const qr = page.getByRole("img", { name: "Scan to pair this browser" });
        await expect(qr).toBeVisible();
        assert.deepEqual(
          creates.map((request) => request.status),
          offset ? [400, 201] : [201],
        );
        assert.equal(
          new Set(creates.map((request) => request.id)).size,
          1,
          "Clock correction keeps the same single-use invitation",
        );
        const png = PNG.sync.read(await qr.screenshot());
        const decoded = jsQR(
          new Uint8ClampedArray(png.data),
          png.width,
          png.height,
        );
        assert.ok(decoded);
        const invitation = decodeInvitation(decoded.data);
        assert.ok(
          invitation.expires * 1000 - Date.now() <= 301000,
          "The QR retains the original five-minute server lifetime",
        );
        const phone = await createIdentity();
        const grant: Grant = {
          id: invitation.id,
          viewer: invitation.viewer,
          phone: b64(phone.publicKey),
          expires: invitation.expires,
          phoneSignature: "",
          mac: "",
        };
        const bytes = grantBytes(origin, grant);
        grant.phoneSignature = b64(await phone.sign(bytes));
        grant.mac = hex(await grantMac(invitation.secret, bytes));
        const device = await sealDevice(invitation.secret, invitation.id, {
          manufacturer: "Test",
          model: "Clock fixture",
          name: "Clock fixture",
          android: "15",
          sdk: 35,
          app: "0.8.0",
        });
        const offered = await fetch(`${base}/api/pair/${invitation.id}/offer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...grant, device }),
        });
        assert.equal(offered.status, 202);
        await expect(page).toHaveURL(/\/phones\/[a-f0-9]{64}$/);
        const paired = (await (
          await fetch(`${base}/api/pair/${invitation.id}`)
        ).json()) as { state: string; grant: Grant };
        assert.equal(paired.state, "paired");
        assert.ok(paired.grant.viewerSignature);
        await verifySignature(
          grant.viewer,
          bytes,
          paired.grant.viewerSignature,
        );
        assert.equal(
          creates.length,
          offset ? 2 : 1,
          "Successful completion must not renew the QR",
        );
      } finally {
        await context.close();
      }
    }
    console.log(
      "PASS real signed QR creation, approval and completion with accurate, ahead and behind browser clocks",
    );
  } finally {
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
}
