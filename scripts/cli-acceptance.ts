/** Real Node CLI -> encrypted relay -> native effects. ADB only provisions/observes the owned fixture. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import type { UiSnapshot } from "../protocol/src/accessibility.js";
import type { Reply } from "../protocol/src/control.js";
import { decodeInvitation } from "../protocol/src/enrollment.js";
import { decodePhoneInvitation } from "../protocol/src/phone-invitation.js";
import { restoreSyntheticLock } from "./synthetic-lock.js";

type Fixture = {
  origin: string;
  state: string;
  page: Page;
  browserId: string;
  adb: (...args: string[]) => string;
  privateWrite: (file: string, value: string) => unknown;
  command: (
    action: string,
    extra?: Record<string, unknown>,
  ) => Promise<unknown>;
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
  fn: () => T | Promise<T>,
  timeout = 30000,
): Promise<NonNullable<T>> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value as NonNullable<T>;
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
    }
    await delay(150);
  }
  throw Error("CLI native acceptance timed out; see private evidence");
}
async function within<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function cliAcceptance(f: Fixture) {
  const { adb, command } = f,
    app = "com.yepcontrol.app";
  assert.equal(adb("shell", "getprop", "ro.kernel.qemu"), "1");
  if (process.env.HOSTED_PROOF_SECRETS)
    throw Error("CLI acceptance needs an un-gated isolated development relay");
  const directory = path.join(f.state, "cli");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const children: ReturnType<typeof spawn>[] = [];
  function cli(home: string, args: string[]) {
    const child = spawn(process.execPath, ["cli/dist/main.js", ...args], {
      env: { ...process.env, YEPCONTROL_HOME: path.join(directory, home) },
    });
    children.push(child);
    const processNumber = children.length;
    let stdout = "",
      stderr = "";
    const messages: Record<string, unknown>[] = [];
    let pending = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d;
      pending += d;
      let at = pending.indexOf("\n");
      while (at >= 0) {
        messages.push(JSON.parse(pending.slice(0, at)));
        pending = pending.slice(at + 1);
        at = pending.indexOf("\n");
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d;
    });
    const done = once(child, "exit").then(async ([code, signal]) => {
      await writeFile(
        path.join(directory, `process-${processNumber}.log`),
        stderr,
        { mode: 0o600 },
      );
      await writeFile(
        path.join(directory, `process-${processNumber}.jsonl`),
        stdout,
        { mode: 0o600 },
      );
      return { code, signal, stdout, stderr };
    });
    return {
      child,
      messages,
      done,
      finish: (ms = 5000) =>
        within(
          done,
          ms,
          `CLI process ${processNumber} did not exit; see private process log`,
        ),
    };
  }
  async function session(home: string) {
    const c = cli(home, ["session", "--stdio", "--json"]);
    const ready = await until(() => {
      assert.equal(
        c.child.exitCode,
        null,
        "CLI exited before ready; see private process log",
      );
      return c.messages.find((m) => m.type === "ready");
    });
    let id = 0;
    return {
      ...c,
      ready,
      async request(op: Record<string, unknown>) {
        const requestId = String(++id);
        c.child.stdin.write(`${JSON.stringify({ id: requestId, ...op })}\n`);
        return until(() =>
          c.messages.find((m) => m.id === requestId),
        ) as Promise<{ ok: boolean; reply?: Reply; error?: string }>;
      },
      async close() {
        c.child.stdin.end();
        assert.equal((await c.finish()).code, 0);
      },
    };
  }
  const witness = () =>
    JSON.parse(
      adb(
        "shell",
        "run-as",
        `${app}.test`,
        "cat",
        "files/control-witness.json",
      ),
    ) as {
      taps: number;
      text: string;
      password: string;
      scroll: number;
      target: { x: number; y: number };
      field: { x: number; y: number };
    };
  const browserUrl = f.page.url();
  await f.page.goto(`${f.origin}/phones`); // Release readiness ownership before the independent CLI connects.
  const ids: string[] = [];
  let screenEnabled = false;
  let syntheticLock = false;
  let failure: unknown;
  try {
    const code = path.join(directory, "terminal-code.txt");
    const p = cli("terminal", [
      "pair",
      "--origin",
      f.origin,
      "--name",
      "Acceptance CLI",
      "--code-file",
      code,
      "--json",
    ]);
    const uri = await until(() => readFile(code, "utf8"));
    const id = decodeInvitation(uri.trim()).id;
    ids.push(id);
    f.privateWrite("hosted-pair-uri", uri.trim());
    await command("pair", { simple: true });
    assert.equal((await p.finish(10000)).code, 0);
    await command("home");
    let s = await session("terminal");
    assert.equal(
      (s.ready.state as { accessibility: boolean }).accessibility,
      false,
    );
    const missing = (await s.request({ op: "snapshot" })).reply;
    assert.equal(missing?.kind, "result");
    assert.equal((missing as { code: number }).code, 1);
    await s.close();
    await command("enable-screen-access");
    screenEnabled = true;
    await command("control-ready", { id });
    s = await session("terminal");
    await command("control-fixture");
    await delay(600);
    async function snapshot() {
      const response = await s.request({ op: "snapshot" });
      assert.equal(response.reply?.kind, "snapshot");
      return (response.reply as { snapshot: UiSnapshot }).snapshot;
    }
    async function action(
      op: string,
      find: (n: UiSnapshot["nodes"][number]) => boolean,
      extra: Record<string, unknown> = {},
    ) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const tree = await snapshot();
        const target = tree.nodes.find(find);
        assert.ok(target, `Missing ${op} target`);
        const request = {
          op,
          observation: tree.observation,
          node: target.node,
          ...extra,
        };
        const result = await s.request(request);
        if (
          result.reply?.kind === "result" &&
          result.reply.code === 2 &&
          attempt < 2
        ) {
          // Explicit stale refusal: observe anew after pending Android events.
          // Never retry an uncertain delivery or reuse the original reference.
          await delay(500);
          continue;
        }
        assert.equal((result.reply as { code: number }).code, 0);
        return request;
      }
      throw new Error("No stable observation for native action");
    }

    const tree = await snapshot();
    assert.ok(tree.nodes.length <= 128);
    const password = tree.nodes.find((n) => n.password);
    assert.ok(password, "Fixture password node exposed as redacted metadata");
    assert.equal(password.text, "");
    assert.equal(password.label, "");
    assert.equal(password.editable, false);
    assert.ok(!JSON.stringify(tree).includes("fixture-private-password"));
    const denied = await s.request({
      op: "nodeText",
      observation: tree.observation,
      node: password.node,
      text: "refused",
    });
    assert.equal((denied.reply as { code: number }).code, 4);
    assert.equal(witness().password, "fixture-private-password");
    const old = await action(
      "nodeClick",
      (n) => n.text === "Tap witness" && n.clickable,
    );
    await until(() => witness().taps === 1);
    assert.equal(((await s.request(old)).reply as { code: number }).code, 2);
    assert.equal(witness().taps, 1);
    await delay(250);
    await action("nodeText", (n) => n.editable, { text: "CLI unicode 🌞" });
    await until(() => witness().text === "CLI unicode 🌞");
    await delay(250);
    await action("nodeClick", (n) => n.editable);
    await s.request({ op: "text", text: "CLI focused text" });
    await until(() => witness().text === "CLI focused text");
    await s.request({ op: "navigation", action: "back" });
    await delay(300);
    const changed = await snapshot();
    const changedTarget = changed.nodes.find((n) => n.text === "Tapped 1");
    assert.ok(changedTarget);
    await command("semantic-probe-start", { editable: false });
    await command("control-fixture-change", { mode: "label" });
    await delay(250);
    assert.equal(
      (
        (
          await s.request({
            op: "nodeClick",
            observation: changed.observation,
            node: changedTarget.node,
          })
        ).reply as { code: number }
      ).code,
      2,
    );
    await command("semantic-probe-act", { expected: 2 });
    assert.equal(witness().taps, 1);
    await command("semantic-probe-start");
    await command("semantic-probe-act", { expected: 0 });
    await until(() => witness().text === "Native guard positive");
    await command("control-fixture-change", { mode: "long-old" });
    await delay(300);
    const long = await snapshot();
    const longTarget = long.nodes.find((n) => n.editable);
    assert.ok(longTarget);
    await command("semantic-probe-start");
    await command("control-fixture-change", { mode: "long-new" });
    await delay(300);
    assert.equal(
      (
        (
          await s.request({
            op: "nodeText",
            observation: long.observation,
            node: longTarget.node,
            text: "must not overwrite",
          })
        ).reply as { code: number }
      ).code,
      2,
    );
    assert.ok(witness().text.endsWith("new"));
    await command("semantic-probe-act", { expected: 2 });
    assert.ok(witness().text.endsWith("new"));
    const ancestry = await snapshot();
    const ancestryTarget = ancestry.nodes.find((n) => n.editable);
    assert.ok(ancestryTarget);
    await command("semantic-probe-start");
    await command("control-fixture-change", { mode: "password-container" });
    await delay(300);
    assert.equal(
      (
        (
          await s.request({
            op: "nodeText",
            observation: ancestry.observation,
            node: ancestryTarget.node,
            text: "must not overwrite",
          })
        ).reply as { code: number }
      ).code,
      2,
    );
    await command("semantic-probe-act", { expected: 2 });
    assert.ok(witness().text.endsWith("new"));
    const protectedTree = await snapshot();
    assert.ok(!protectedTree.nodes.some((n) => n.editable));
    await command("control-fixture");
    await delay(500);
    const scrollBefore = witness().scroll;
    await action("nodeScroll", (n) => n.scrollable, { direction: "forward" });
    await until(() => witness().scroll > scrollBefore);
    await command("control-fixture");
    await delay(500);
    const expired = await snapshot();
    const expiredNode = expired.nodes.find((n) => n.clickable);
    assert.ok(expiredNode);
    await delay(30100);
    assert.equal(
      (
        (
          await s.request({
            op: "nodeClick",
            observation: expired.observation,
            node: expiredNode.node,
          })
        ).reply as { code: number }
      ).code,
      2,
    );
    const screenshot = await s.request({ op: "capture" });
    assert.equal(screenshot.reply?.kind, "image");
    const image = screenshot.reply as unknown as {
      scene: number;
      jpeg: string;
      width: number;
      height: number;
    };
    const jpeg = Buffer.from(image.jpeg, "base64");
    assert.equal(jpeg[0], 255);
    assert.equal(jpeg[1], 216);
    assert.ok(jpeg.length > 1000);
    await writeFile(path.join(directory, "screen.jpg"), jpeg, { mode: 0o600 });
    const point = witness().target;
    assert.equal(
      (
        (
          await s.request({
            op: "tap",
            scene: image.scene,
            x: point.x,
            y: point.y,
          })
        ).reply as { code: number }
      ).code,
      0,
    );
    await until(() => witness().taps === 1);
    const coordinates = (await s.request({ op: "capture" })).reply as {
      scene: number;
    };
    assert.equal(
      (
        (
          await s.request({
            op: "tap",
            scene: coordinates.scene,
            x: 100000,
            y: 0,
          })
        ).reply as { code: number }
      ).code,
      2,
    );
    const swipeBefore = witness().scroll;
    const swiped = await s.request({
      op: "swipe",
      scene: coordinates.scene,
      x: Math.floor(image.width / 2),
      y: image.height - 250,
      endX: Math.floor(image.width / 2),
      endY: Math.floor(image.height / 2),
      duration: 400,
    });
    assert.equal((swiped.reply as { code: number }).code, 0);
    await until(() => witness().scroll > swipeBefore);
    await command("control-fixture");
    await delay(500);

    const saved = await snapshot();
    const savedNode = saved.nodes.find((n) => n.clickable);
    assert.ok(savedNode);
    await s.close();
    await command("control-ready", { id });
    s = await session("terminal");
    assert.equal(
      (
        (
          await s.request({
            op: "nodeClick",
            observation: saved.observation,
            node: savedNode.node,
          })
        ).reply as { code: number }
      ).code,
      2,
    );
    await command("phone-code");
    assert.equal(
      ((await s.request({ op: "snapshot" })).reply as { code: number }).code,
      4,
    );
    assert.equal(
      (
        (
          await s.request({
            op: "nodeClick",
            observation: saved.observation,
            node: savedNode.node,
          })
        ).reply as { code: number }
      ).code,
      4,
    );
    await command("cancel-code");
    await command("control-fixture");
    await delay(500);
    // Owned-emulator credential only: the default AVD can have no keyguard.
    await writeFile(
      path.join(f.state, "synthetic-lock"),
      "owned-emulator-fixture\n",
      { mode: 0o600 },
    );
    syntheticLock = true;
    assert.match(adb("shell", "locksettings", "set-pin", "314159"), /Pin set/);
    assert.equal(
      ((await s.request({ op: "sleep" })).reply as { code: number }).code,
      0,
    );
    await delay(500);
    assert.equal(
      ((await s.request({ op: "snapshot" })).reply as { code: number }).code,
      3,
    );
    await s.request({ op: "wake" });
    await restoreSyntheticLock(f);
    syntheticLock = false;
    // Interrupted setup before installation: marker exists, no credential.
    await writeFile(
      path.join(f.state, "synthetic-lock"),
      "owned-emulator-fixture\n",
      { mode: 0o600 },
    );
    await restoreSyntheticLock(f);
    // Interrupted restoration immediately after clear: same absent credential,
    // with a different provenance. Exercise Android's real no-password response.
    await writeFile(
      path.join(f.state, "synthetic-lock"),
      "owned-emulator-fixture\n",
      { mode: 0o600 },
    );
    syntheticLock = true;
    assert.match(adb("shell", "locksettings", "set-pin", "314159"), /Pin set/);
    assert.match(
      adb("shell", "locksettings", "clear", "--old", "314159"),
      /Lock credential cleared/,
    );
    await restoreSyntheticLock(f);
    syntheticLock = false;
    await until(async () => {
      const reply = (await s.request({ op: "status" })).reply;
      return reply?.kind === "state" && !reply.state.locked;
    });
    await s.request({ op: "navigation", action: "home" });
    assert.match(
      adb("shell", "dumpsys", "activity", "activities"),
      /topResumedActivity=.*launcher/i,
    );
    await s.request({ op: "launch", packageName: `${app}.test` });
    await until(() =>
      /topResumedActivity=.*ControlFixtureActivity/.test(
        adb("shell", "dumpsys", "activity", "activities"),
      ),
    );
    await s.close();
    // The opposite pairing direction uses the normal protected Show code view.
    await command("phone-code");
    const bytes = Buffer.from(
      adb("shell", "run-as", app, "base64", "files/phone-code.png").replace(
        /\s/g,
        "",
      ),
      "base64",
    );
    const png = PNG.sync.read(bytes),
      decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    assert.ok(decoded);
    const phoneInvite = decodePhoneInvitation(decoded.data, f.origin);
    ids.push(phoneInvite.id);
    const phonePair = cli("phone", [
      "pair",
      "--origin",
      f.origin,
      "--from-stdin",
      "--json",
    ]);
    phonePair.child.stdin.end(decoded.data);
    assert.equal((await phonePair.finish(100000)).code, 0);
    await command("phone-paired", { id: phoneInvite.id });
    await command("control-ready", { id });
    s = await session("terminal");
    await command("enable", { id, enabled: false });
    assert.equal((await s.request({ op: "status" })).ok, false);
    s.child.stdin.end();
    assert.equal((await s.finish()).code, 1);
    await command("remove", { id });
    ids.splice(ids.indexOf(id), 1);
    await command("control-ready", { id: phoneInvite.id });
    const other = await session("phone");
    assert.equal((await other.request({ op: "status" })).ok, true);
    await other.close();
    await command("remove", { id: phoneInvite.id });
    ids.splice(ids.indexOf(phoneInvite.id), 1);
    await writeFile(
      path.join(directory, "result.json"),
      `${JSON.stringify({
        bothPairingDirections: true,
        missingPermission: true,
        nativeNodeClick: true,
        targetedUnicodeText: true,
        nativeScroll: true,
        passwordRedacted: true,
        staleChangedExpiredAndSessionReferencesRefused: true,
        protectedSettings: true,
        lockedRefusal: true,
        screenshot: true,
        coordinateTap: true,
        navigation: true,
        launch: true,
        independentPauseRemoval: true,
      })}\n`,
      { mode: 0o600 },
    );
    console.log(
      "PASS real CLI both pairing directions, accessibility effects/refusals and independent revocation",
    );
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    async function restore(work: () => Promise<unknown>) {
      try {
        await work();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const child of children)
      await restore(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        try {
          await within(exited, 1500, "CLI ignored termination");
        } catch {
          child.kill("SIGKILL");
          await within(exited, 3000, "CLI did not exit after SIGKILL");
        }
      });
    if (syntheticLock) await restore(() => restoreSyntheticLock(f));
    for (const id of ids) await restore(() => command("remove", { id }));
    await restore(() =>
      screenEnabled
        ? command("control-ready", { id: f.browserId })
        : command("home"),
    );
    await restore(() => f.page.goto(browserUrl));
    if (cleanupErrors.length) {
      await writeFile(
        path.join(directory, "cleanup-errors.log"),
        cleanupErrors.map(String).join("\n"),
        { mode: 0o600 },
      );
      failure ??= new AggregateError(
        cleanupErrors,
        "CLI fixture cleanup failed; see private evidence",
      );
    }
  }
  if (failure) throw failure;
}
