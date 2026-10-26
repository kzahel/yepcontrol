import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { type Browser, expect } from "@playwright/test";
import { sealDevice } from "../protocol/src/device.js";
import {
  type Grant,
  grantBytes,
  grantMac,
  hex,
  revokeBytes,
} from "../protocol/src/enrollment.js";
import { b64, createIdentity } from "../protocol/src/index.js";
import {
  type BrowserClaim,
  encodePhoneInvitation,
  type PhoneInvitation,
  phoneCreateBytes,
  verifyClaim,
} from "../protocol/src/phone-invitation.js";
import { createRelay } from "../relay/src/server.js";

export async function verifyPhoneFirstBrowser(
  browser: Browser,
  origin: string,
  artifacts: string,
) {
  const directory = await mkdtemp(path.join(artifacts, "phone-first-relay-"));
  const relay = createRelay({ origin, stateDir: directory, pairWaitMs: 50 });
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const address = relay.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (const mode of [
      "normal",
      "lost-claim",
      "wrong-phone",
      "cancelled",
    ] as const) {
      const phone = await createIdentity();
      const time = (await (await fetch(`${base}/api/pairing-time`)).json()) as {
        expires: number;
      };
      const invite: PhoneInvitation = {
        v: 1,
        origin,
        id: hex(crypto.getRandomValues(new Uint8Array(16))),
        phone: b64(phone.publicKey),
        secret: hex(crypto.getRandomValues(new Uint8Array(32))),
        expires: time.expires,
      };
      const api = (action = "", value?: unknown) =>
        fetch(
          `${base}/api/pair/${invite.id}${action ? `/${action}` : ""}`,
          value === undefined
            ? {}
            : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(value),
              },
        );
      assert.equal(
        (
          await api("invite", {
            phone: invite.phone,
            expires: invite.expires,
            signature: b64(await phone.sign(phoneCreateBytes(origin, invite))),
          })
        ).status,
        201,
      );
      const cancel = async () =>
        api("revoke", {
          signature: b64(await phone.sign(revokeBytes(origin, invite.id))),
        });
      if (mode === "cancelled") await cancel();
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        ignoreHTTPSErrors: true,
      });
      try {
        await context.addInitScript(() => {
          const realNow = Date.now.bind(Date);
          Date.now = () => realNow() + 315360000000;
        });
        const page = await context.newPage();
        let claims = 0,
          sockets = 0,
          forged: unknown,
          replaying = false,
          failedPoll = false;
        page.on("websocket", () => sockets++);
        await context.route("**/api/**", async (route) => {
          const request = route.request();
          assert.ok(!request.url().includes(invite.secret));
          assert.ok(
            !request.postData()?.includes(invite.secret),
            "The QR secret must not reach the relay",
          );
          const pathname = new URL(request.url()).pathname;
          if (
            mode === "normal" &&
            claims === 1 &&
            !replaying &&
            !failedPoll &&
            pathname === `/api/pair/${invite.id}` &&
            request.method() === "GET"
          ) {
            failedPoll = true;
            await route.fulfill({
              status: 503,
              headers: { "Retry-After": "1" },
              json: { error: "Temporary fixture failure" },
            });
            return;
          }
          if (
            forged &&
            pathname === `/api/pair/${invite.id}` &&
            request.method() === "GET"
          ) {
            await route.fulfill({ json: forged });
            return;
          }
          const response = await route.fetch({ url: base + pathname });
          if (pathname.endsWith("/claim")) {
            if (!replaying) claims++;
            if (mode === "lost-claim" && !replaying) {
              await route.abort("connectionreset");
              return;
            }
          }
          await route.fulfill({ response });
        });
        await page.goto(encodePhoneInvitation(invite));
        await expect.poll(() => new URL(page.url()).hash).toBe("");
        if (mode === "cancelled") {
          await expect(page.getByRole("status")).toContainText(
            "This code is unavailable.",
          );
          assert.equal((await api()).status, 410);
          continue;
        }
        let claim: BrowserClaim | undefined;
        await expect
          .poll(async () => {
            const state = (await (await api()).json()) as {
              claim?: BrowserClaim;
            };
            claim = state.claim;
            return !!claim;
          })
          .toBe(true);
        assert.ok(claim);
        await verifyClaim(invite, claim);
        const signer = mode === "wrong-phone" ? await createIdentity() : phone;
        const grant: Grant = {
          id: invite.id,
          phone: b64(signer.publicKey),
          viewer: claim.viewer,
          expires: invite.expires,
          phoneSignature: "",
          mac: "",
        };
        const bytes = grantBytes(origin, grant);
        grant.phoneSignature = b64(await signer.sign(bytes));
        grant.mac = hex(await grantMac(invite.secret, bytes));
        const device = await sealDevice(invite.secret, invite.id, {
          manufacturer: "Test",
          model: "Phone QR fixture",
          name: "Phone QR fixture",
          android: "15",
          sdk: 35,
          app: "0.9.0",
        });
        if (mode === "wrong-phone") {
          forged = { state: "offered", grant, device };
          await expect(page.getByRole("status")).toContainText(
            "Phone identity changed",
          );
          assert.equal(
            ((await (await api()).json()) as { state: string }).state,
            "claimed",
          );
        } else {
          assert.equal((await api("offer", { ...grant, device })).status, 202);
          await expect(page).toHaveURL(/\/phones\/[a-f0-9]{64}$/);
          await expect.poll(() => sockets).toBe(1);
          assert.equal(
            new URL(page.url()).search,
            "",
            "One-shot auto-connect flag is consumed",
          );
          assert.equal(
            ((await (await api()).json()) as { state: string }).state,
            "paired",
          );
          if (mode === "normal")
            assert.ok(failedPoll, "A transient approval poll failure recovers");
          replaying = true;
          const replay = await context.newPage();
          await replay.goto(encodePhoneInvitation(invite));
          await expect(replay.getByRole("status")).toContainText("400");
          await replay.close();
        }
        assert.equal(
          claims,
          1,
          "An uncertain claim receipt must not post a second claim",
        );
        await page.screenshot({
          path: path.join(artifacts, `phone-first-${mode}.png`),
        });
      } finally {
        await context.close();
        await cancel();
      }
    }
    console.log(
      "PASS phone-first browser pairing, secret scrubbing, lost claim receipt, phone pinning, one-use replay, cancellation and automatic connection",
    );
  } finally {
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
}
