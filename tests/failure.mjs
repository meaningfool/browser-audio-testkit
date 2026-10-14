import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVoiceBrowserSession } from "@meaningfool/browser-audio-testkit";

await test("consumer failure still flushes recording and releases the owned context", { timeout: 60000 }, async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "audio-failed-consumer-"));
  const session = await createVoiceBrowserSession({ origin: "https://neutral.invalid", outputDir });
  let consumerError;
  try {
    await session.context.route("https://neutral.invalid/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
    await session.page.goto("https://neutral.invalid/");
    await session.startRecording();
    await session.page.evaluate("navigator.mediaDevices.getUserMedia({audio:true})");
    throw new Error("deliberate consumer failure");
  } catch (error) {
    consumerError = error;
  } finally {
    await session.close();
    await session.close();
  }
  try {
    assert.equal(consumerError.message, "deliberate consumer failure");
    assert.equal(session.page.isClosed(), true);
    const { readFile } = await import("node:fs/promises");
    const metadata = JSON.parse(await readFile(join(outputDir, "capture.json"), "utf8"));
    assert.equal(metadata.state, "finished");
    assert.ok(metadata.bytes > 0);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
