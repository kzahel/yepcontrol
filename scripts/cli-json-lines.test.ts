import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { cliJsonLines } from "./cli-json-lines.js";

test("actual subprocess chunks retain complete replies and split UTF-8", async () => {
  const child = spawn(process.execPath, [
    "-e",
    `
    process.stdout.write(JSON.stringify({type:'ready'})+'\\n');
    const reply = Buffer.from(JSON.stringify({id:'capture',ok:true,reply:{label:'🌞',jpeg:'a'.repeat(200000)}})+'\\n');
    const split = reply.indexOf(Buffer.from('🌞')) + 2;
    process.stdout.write(reply.subarray(0,split));
    process.stderr.write('partial');
    setTimeout(()=>process.stdout.write(reply.subarray(split)),650);
  `,
  ]);
  assert.ok(child.stdout);
  const lines = cliJsonLines(child.stdout);
  const closed = once(child, "close");
  try {
    await once(child.stderr, "data");
    const end = Date.now() + 500;
    while (lines.read().length === 0 && Date.now() < end)
      await new Promise((r) => setTimeout(r, 10));
    expect(lines.read()).toEqual([{ type: "ready" }]);
    const [code] = await closed;
    expect(code).toBe(0);
    expect(lines.read()).toEqual([
      { type: "ready" },
      {
        id: "capture",
        ok: true,
        reply: { label: "🌞", jpeg: "a".repeat(200000) },
      },
    ]);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await closed;
    lines.close();
  }
});

test("a truncated exit refuses its partial reply", async () => {
  const stream = new PassThrough();
  const lines = cliJsonLines(stream);
  try {
    stream.end('{"id":"capture","ok":true');
    await once(stream, "end");
    expect(() => lines.read()).toThrow("Incomplete CLI JSON record");
  } finally {
    lines.close();
  }
});
