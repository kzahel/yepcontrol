/** Optional sampled UI recording of the owned emulator and real viewer; never enabled in CI. */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";

const exec = promisify(execFile);
export async function recordMediaReview(d: {
  page: Page;
  adbPath: string;
  serial: string;
  state: string;
}) {
  const directory = path.join(d.state, "media-review");
  await mkdir(path.join(directory, "frames"), { recursive: true, mode: 0o700 });
  const start = Date.now();
  let active = true,
    caption = "Optional camera and microphone sharing";
  const frames: { at: number; file: string; caption: string }[] = [];
  const chapters: { at: number; text: string }[] = [];
  const capture = (async () => {
    while (active && frames.length < 450 && Date.now() - start < 180000) {
      const at = Date.now(),
        text = caption,
        stem = String(frames.length).padStart(5, "0");
      const [phone, web] = await Promise.all([
        exec(d.adbPath, ["-s", d.serial, "exec-out", "screencap", "-p"], {
          encoding: "buffer",
          timeout: 10000,
          maxBuffer: 16 * 1024 * 1024,
        }),
        d.page.screenshot({ type: "png" }),
      ]);
      await Promise.all([
        writeFile(
          path.join(directory, "frames", `${stem}-phone.png`),
          phone.stdout,
          { mode: 0o600 },
        ),
        writeFile(path.join(directory, "frames", `${stem}-web.png`), web, {
          mode: 0o600,
        }),
      ]);
      frames.push({ at: (at - start) / 1000, file: stem, caption: text });
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 400 - (Date.now() - at))),
      );
    }
  })();
  // Observe rejection immediately; finish() still reports it to the caller.
  void capture.catch(() => {});
  let finishing: Promise<void> | undefined;
  return {
    chapter(text: string) {
      caption = text;
      chapters.push({ at: (Date.now() - start) / 1000, text });
    },
    finish() {
      finishing ??= (async () => {
        active = false;
        const duration = (Date.now() - start) / 1000;
        try {
          await capture;
        } finally {
          await writeFile(
            path.join(directory, "timeline.json"),
            JSON.stringify(
              { sampledUi: true, duration, frames, chapters },
              null,
              2,
            ),
            { mode: 0o600 },
          );
        }
      })();
      return finishing;
    },
  };
}
