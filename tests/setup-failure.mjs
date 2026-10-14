import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVoiceBrowserSession } from "@meaningfool/browser-audio-testkit";

await test("failed setup releases profile and capture file", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "audio-failed-setup-"));
  const before = await readdir(tmpdir());
  try {
    await assert.rejects(createVoiceBrowserSession({ origin: "https://neutral.invalid", outputDir }), /Executable doesn't exist/);
    assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith("browser-audio-testkit-") && !before.includes(name)), []);
    assert.deepEqual(await readdir(outputDir), []);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
