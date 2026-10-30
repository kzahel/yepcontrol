/** Browser screenshots and encrypted input only; no ADB control or phone-side invitation export. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import type { UiSnapshot } from "../protocol/src/accessibility.js";
import type { Reply } from "../protocol/src/control.js";
import { decodePhoneInvitation } from "../protocol/src/phone-invitation.js";
import { cliJsonLines } from "./cli-json-lines.js";

function assertDefined<T>(value: T | undefined): T {
  assert.notEqual(value, undefined);
  return value as T;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  work: () => T | Promise<T>,
  label: string,
  timeout = 30000,
): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await work();
    if (value) return value as NonNullable<T>;
    await delay(300);
  }
  throw Error(label);
}
const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export async function remoteAdoption(f: {
  page: Page;
  origin: string;
  state: string;
}) {
  const { page, origin } = f;
  const directory = path.join(f.state, `remote-adoption-${Date.now()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const browserUrl = page.url();
  const canvas = page.getByLabel("Phone screen", { exact: true });
  let imageNumber = 0;
  async function frame() {
    const captured = await canvas.evaluate((e) => ({
      encoded: (e as HTMLCanvasElement).toDataURL("image/png").split(",")[1],
      video:
        (window as unknown as { __adoptionLastVideo?: boolean })
          .__adoptionLastVideo === true,
    }));
    const encoded = captured.encoded;
    const bytes = Buffer.from(assertDefined(encoded), "base64");
    await writeFile(path.join(directory, `frame-${++imageNumber}.png`), bytes, {
      mode: 0o600,
    });
    return { bytes, png: PNG.sync.read(bytes), video: captured.video };
  }
  function words(bytes: Buffer) {
    const lines: {
      text: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }[][] = [];
    function read(image: Buffer, psm: string, dx = 0, dy = 0) {
      const tsv = execFileSync(
        process.env.TESSERACT ?? "tesseract",
        ["stdin", "stdout", "--psm", psm, "tsv"],
        {
          input: image,
          maxBuffer: 2 * 1024 * 1024,
          timeout: 10000,
          stdio: ["pipe", "pipe", "ignore"],
        },
      ).toString();
      const grouped = new Map<
        string,
        { text: string; x: number; y: number; w: number; h: number }[]
      >();
      for (const row of tsv.split("\n").slice(1)) {
        const v = row.split("\t");
        if (v[0] !== "5" || !v[11]?.trim()) continue;
        const key = v.slice(1, 5).join(":"),
          line = grouped.get(key) ?? [];
        line.push({
          text: normalize(v[11]),
          x: Number(v[6]) + dx,
          y: Number(v[7]) + dy,
          w: Number(v[8]),
          h: Number(v[9]),
        });
        grouped.set(key, line);
      }
      lines.push(...grouped.values());
    }
    read(bytes, "11");
    // Sparse OCR misses white labels on the native green primary buttons.
    // Find broad green rows in the received pixels and invert only those crops.
    const source = PNG.sync.read(bytes);
    const green = (x: number, y: number) => {
      const at = (y * source.width + x) * 4;
      return (
        (source.data[at + 1] ?? 0) > (source.data[at] ?? 0) * 1.2 &&
        (source.data[at + 1] ?? 0) > (source.data[at + 2] ?? 0) * 1.1 &&
        (source.data[at + 1] ?? 0) < 180
      );
    };
    let start = -1;
    for (let y = 0; y <= source.height; y++) {
      let count = 0;
      if (y < source.height)
        for (let x = 0; x < source.width; x += 4) if (green(x, y)) count++;
      if (count * 4 > source.width * 0.45) {
        if (start < 0) start = y;
        continue;
      }
      if (start < 0) continue;
      const top = start;
      start = -1;
      if (y - top < 20) continue;
      const middle = Math.floor((top + y) / 2);
      let left = 0,
        right = source.width - 1;
      while (left < right && !green(left, middle)) left++;
      while (right > left && !green(right, middle)) right--;
      left += 5;
      right -= 5;
      const width = right - left + 1,
        height = y - top - 6;
      if (width < 40 || height < 10) continue;
      const crop = new PNG({ width, height });
      for (let cy = 0; cy < height; cy++)
        for (let cx = 0; cx < width; cx++) {
          const from = ((top + 3 + cy) * source.width + left + cx) * 4,
            to = (cy * width + cx) * 4;
          for (let color = 0; color < 3; color++)
            crop.data[to + color] = 255 - (source.data[from + color] ?? 0);
          crop.data[to + 3] = 255;
        }
      read(PNG.sync.write(crop), "7", left, top + 3);
    }
    return lines;
  }
  async function locate(text: string | string[], menu = false) {
    const wanted = new Set(
      (Array.isArray(text) ? text : [text]).map(normalize),
    );
    const point = await until(async () => {
      const { bytes, png } = await frame();
      const matches: {
        x: number;
        y: number;
        width: number;
        height: number;
        exact: boolean;
      }[] = [];
      for (const line of words(bytes)) {
        for (let a = 0; a < line.length; a++)
          for (let b = a; b < line.length; b++) {
            if (
              !wanted.has(
                line
                  .slice(a, b + 1)
                  .map((v) => v.text)
                  .join(" "),
              ) ||
              (menu && (line[a]?.y ?? png.height) > png.height * 0.15)
            )
              continue;
            const first = assertDefined(line[a]),
              last = assertDefined(line[b]);
            matches.push({
              x: (first.x + last.x + last.w) / 2,
              y: first.y + first.h / 2,
              width: png.width,
              height: png.height,
              exact: a === 0 && b === line.length - 1,
            });
          }
      }
      matches.sort((a, b) => Number(b.exact) - Number(a.exact) || b.y - a.y);
      return matches[0];
    }, `Remote screenshot did not expose ${text}`);
    return point;
  }
  async function clickText(
    text: string | string[],
    options: {
      menu?: boolean;
      next?: string | string[];
    } = {},
  ) {
    const point = await locate(text, options.menu);
    const bounds = await canvas.boundingBox();
    assert.ok(bounds);
    await page.evaluate(() => {
      const w = window as unknown as {
        __adoptionDraws?: number;
        __adoptionLastVideo?: boolean;
      };
      if (w.__adoptionDraws === undefined) {
        w.__adoptionDraws = 0;
        const original = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = new Proxy(original, {
          apply(target, context: CanvasRenderingContext2D, args) {
            if (context.canvas.getAttribute("aria-label") === "Phone screen") {
              w.__adoptionDraws = (w.__adoptionDraws ?? 0) + 1;
              w.__adoptionLastVideo =
                typeof VideoFrame !== "undefined" &&
                args[0] instanceof VideoFrame;
            }
            return Reflect.apply(target, context, args);
          },
        });
      }
      return w.__adoptionDraws;
    });
    await page.mouse.click(
      bounds.x + (options.menu ? 0.07 : point.x / point.width) * bounds.width,
      bounds.y + (point.y / point.height) * bounds.height,
    );
    await appendFile(
      path.join(directory, "actions.jsonl"),
      `${JSON.stringify({ target: text, point })}\n`,
      { mode: 0o600 },
    );
    await delay(200);
    if (options.next) await locate(options.next);
  }
  async function invitation(requireVideo = false) {
    return until(async () => {
      const { png, video } = await frame();
      if (requireVideo && !video) return undefined;
      const qr = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
      if (!qr) return undefined;
      decodePhoneInvitation(qr.data, origin);
      return qr.data;
    }, "Browser could not decode the phone-issued code");
  }
  async function connect() {
    await page.goto(browserUrl);
    await page
      .getByRole("button", { name: "Connect to phone", exact: true })
      .click({ timeout: 80000 });
    await page
      .getByRole("button", { name: "Fullscreen", exact: true })
      .waitFor({ timeout: 80000 });
    await delay(800);
  }
  const children: ReturnType<typeof spawn>[] = [];
  function cli(args: string[]) {
    const c = spawn(process.execPath, ["cli/dist/main.js", ...args], {
      env: {
        ...process.env,
        YEPCONTROL_HOME: path.join(directory, "identity"),
      },
    });
    children.push(c);
    const lines = cliJsonLines(c.stdout);
    c.stderr.setEncoding("utf8");
    let stdout = "",
      stderr = "";
    c.stdout.on("data", (d: string) => {
      stdout += d;
    });
    c.stderr.on("data", (d: string) => {
      stderr += d;
    });
    const done = once(c, "close").then(async ([code]) => {
      lines.close();
      await writeFile(
        path.join(directory, `process-${children.indexOf(c)}.jsonl`),
        stdout,
        { mode: 0o600 },
      );
      await writeFile(
        path.join(directory, `process-${children.indexOf(c)}.log`),
        stderr,
        { mode: 0o600 },
      );
      return { code, stdout, stderr };
    });
    return { c, done, records: () => lines.read() };
  }
  async function finish(c: ReturnType<typeof cli>, timeout = 10000) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        c.done,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("CLI adoption process did not finish")),
            timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  let live: ReturnType<typeof cli> | undefined;
  try {
    await clickText("Give control", { next: "Show code" });
    await clickText("Show code");
    const link = await invitation();
    const id = decodePhoneInvitation(link, origin).id;
    console.log("Browser remotely displayed and decoded the phone invitation");
    const paired = cli([
      "pair",
      "--origin",
      origin,
      "--name",
      "Adoption CLI",
      "--from-stdin",
      "--json",
    ]);
    paired.c.stdin.end(link);
    assert.equal((await finish(paired, 100000)).code, 0);
    await page.goto(`${origin}/phones`);
    live = cli(["session", "--stdio", "--json"]);
    await until(
      () => live?.records().find((record) => record.type === "ready"),
      "Adopted CLI did not connect",
      80000,
    );
    console.log(
      "Real CLI paired through stdin and connected with its own identity",
    );
    let requestId = 0;
    async function request(command: Record<string, unknown>) {
      assert.ok(live);
      const id = String(++requestId);
      live.c.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
      const response = await until(
        () => live?.records().find((record) => record.id === id),
        "Missing CLI adoption reply",
      );
      assert.equal(response.ok, true);
      assert.ok(response.reply);
      return response.reply as Reply;
    }
    assert.equal((await request({ op: "status" })).kind, "state");
    assert.equal((await request({ op: "capture" })).kind, "image");
    const launched = await request({
      op: "launch",
      packageName: "com.android.settings",
    });
    assert.equal(launched.kind, "result");
    assert.equal((launched as { code: number }).code, 0);
    await delay(700);
    assert.equal((await request({ op: "capture" })).kind, "image");
    await request({ op: "launch", packageName: "com.yepcontrol.app" });
    await delay(700);
    async function snapshot() {
      const r = await request({ op: "snapshot" });
      assert.equal(r.kind, "snapshot");
      return (r as { snapshot: UiSnapshot }).snapshot;
    }
    async function nodeClick(text: string) {
      const tree = await snapshot();
      const node = tree.nodes.find(
        (n) => n.clickable && (n.text === text || n.label === text),
      );
      assert.ok(node, `No CLI target ${text}`);
      const r = await request({
        op: "nodeClick",
        observation: tree.observation,
        node: node.node,
      });
      assert.equal(r.kind, "result");
      assert.equal((r as { code: number }).code, 0);
      await delay(600);
    }
    for (let n = 0; n < 4; n++) {
      if (
        (await snapshot()).nodes.some(
          (v) => v.text === "Give control" && v.clickable,
        )
      )
        break;
      await request({ op: "navigation", action: "back" });
      await delay(500);
    }
    await nodeClick("Give control");
    await nodeClick("Show code");
    const shot = await request({ op: "capture" });
    assert.equal(shot.kind, "image");
    // The CLI's JPEG bytes are also capable of seeing the pairing code. Decode through Chromium.
    const b64 = (shot as unknown as { jpeg: string }).jpeg;
    const raster = await page.evaluate(async (jpeg) => {
      const bytes = Uint8Array.from(atob(jpeg), (value) => value.charCodeAt(0));
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: "image/jpeg" }),
      );
      const c = document.createElement("canvas");
      c.width = bitmap.width;
      c.height = bitmap.height;
      const context = c.getContext("2d");
      if (!context) throw Error("Missing image decoder");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return c.toDataURL("image/png").split(",")[1];
    }, b64);
    const png = PNG.sync.read(Buffer.from(assertDefined(raster), "base64"));
    const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert.ok(code);
    decodePhoneInvitation(code.data, origin);
    console.log(
      "Adopted CLI independently controlled apps and captured a configuration code",
    );
    await nodeClick("Cancel");
    await request({ op: "navigation", action: "back" });
    live.c.stdin.end();
    assert.equal((await finish(live)).code, 0);
    live = undefined;
    await connect();
    await clickText("All browsers", {
      next: "Each pairing has its own access",
    });
    await clickText("Adoption CLI", { next: "Allow this device" });
    await clickText("Remove device", { next: "Remove Adoption CLI" });
    await clickText("Remove", { next: "Allowed browsers" });
    await until(
      async () => (await fetch(`${origin}/api/pair/${id}`)).status === 410,
      "Relay did not confirm independent CLI revocation",
    );
    const removed = cli(["status", "--json"]);
    const denied = await finish(removed, 30000);
    assert.equal(denied.code, 1);
    assert.ok(denied.stderr.includes('"ok":false'));
    await page
      .getByRole("button", { name: "Fullscreen", exact: true })
      .waitFor();
    await writeFile(
      path.join(directory, "result.json"),
      JSON.stringify({
        browserOnlyCodeCapture: true,
        cliPairedFromStdin: true,
        independentCliControl: true,
        cliConfigurationCapture: true,
        cliRemovedByBrowser: true,
        relayRevocationConfirmed: true,
        browserStillUsable: true,
        id,
      }),
      { mode: 0o600 },
    );
    console.log(
      "PASS existing browser remotely adopted a real CLI; both configured/captured and independent CLI removal preserved browser access",
    );
    return {
      async verifyProtection() {
        assert.equal(
          await page
            .getByRole("switch", { name: "Smooth view", exact: true })
            .getAttribute("aria-checked"),
          "true",
          "Configuration capture must be exercised with active video",
        );
        // The caller has established real video. Launch through the browser's
        // ordinary app picker; neither targeting nor invitation reading uses ADB.
        await page
          .getByRole("button", { name: "Type or open an app", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Choose an app", exact: true })
          .click();
        await page
          .getByRole("combobox", { name: "Open app" })
          .selectOption("com.yepcontrol.app");
        await page
          .getByRole("button", { name: "Close typing controls", exact: true })
          .click();
        await delay(900);
        // Independent removal left MainActivity on its Allowed browsers page.
        await clickText(["Give control", "Allow another browser"], {
          next: "Show code",
        });
        await clickText("Show code");
        await invitation(true);
        await clickText("Cancel", { next: "Show code" });
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await delay(900);
        await clickText(["This phone", "Allowed browsers"], {
          menu: true,
          next: "Settings",
        });
        await clickText("Settings", { next: "Screen and control" });
        for (let n = 0; n < 2; n++) {
          const box = await canvas.boundingBox();
          assert.ok(box);
          await page.mouse.move(
            box.x + box.width / 2,
            box.y + box.height * 0.8,
          );
          await page.mouse.down();
          await delay(120);
          await page.mouse.move(
            box.x + box.width / 2,
            box.y + box.height * 0.3,
            { steps: 12 },
          );
          await delay(120);
          await page.mouse.up();
          await delay(700);
        }
        await clickText("Allow unrestricted remote control", {
          next: "Off Pairing and unlock",
        });
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await delay(900);
        await clickText("Give control");
        await page
          .getByRole("heading", {
            name: "Change these settings on the phone",
            exact: true,
          })
          .waitFor({ timeout: 20000 });
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await page
          .getByRole("heading", {
            name: "Change these settings on the phone",
            exact: true,
          })
          .waitFor({ state: "hidden", timeout: 20000 });
        await locate("Give control");
        await writeFile(
          path.join(directory, "protection-result.json"),
          JSON.stringify({
            configurationCodeVisibleInVideo: true,
            remotelyDisabled: true,
            protectedCaptureRestored: true,
            ordinaryControlRetained: true,
          }),
          { mode: 0o600 },
        );
        console.log(
          "PASS live configuration video and remote disable restored protected input/capture while retaining ordinary control",
        );
      },
    };
  } finally {
    for (const c of children)
      if (c.exitCode === null && c.signalCode === null) {
        const exited = once(c, "exit");
        c.kill("SIGTERM");
        await Promise.race([exited, delay(2000)]);
        if (c.exitCode === null && c.signalCode === null) {
          c.kill("SIGKILL");
          await exited;
        }
      }
  }
}
