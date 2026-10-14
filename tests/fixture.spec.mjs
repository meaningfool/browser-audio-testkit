import { test as voiceTest, expect } from "@meaningfool/browser-audio-testkit/playwright";
import { access, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { tone, neutral } from "./helpers.mjs";

const test = voiceTest.extend({
  browser: async ({}, use) => {
    throw new Error("Audio page/context must not request the stock browser");
  },
  journey: async ({ page }, use) => {
    await use(page);
  },
});
test.use({ voiceBrowserOptions: { origin: "https://neutral.invalid" } });
test.afterEach(async ({ page, voiceBrowser }, testInfo) => {
  await writeFile(testInfo.outputPath("observed.json"), JSON.stringify({
    outputDir: voiceBrowser.outputDir, retry: testInfo.retry, title: testInfo.title,
    pageUrl: page.url(),
  }));
  // afterEach runs before fixture teardown; the child process verifies closure.
  voiceBrowser.context.once("close", () => {
    void writeFile(testInfo.outputPath("context-released"), "closed");
  });
  voiceBrowser.context.browser().once("disconnected", () => {
    void writeFile(testInfo.outputPath("browser-released"), "closed");
  });
  if (page.isClosed()) await writeFile(testInfo.outputPath("released"), "closed");
  else page.once("close", () => {
    void writeFile(testInfo.outputPath("released"), "closed");
  });
});

test("ordinary journey and option isolation", async ({ page, context, voiceBrowser, journey }, testInfo) => {
  expect(page).toBe(voiceBrowser.page);
  expect(context).toBe(voiceBrowser.context);
  expect(journey).toBe(page);
  expect(context.pages()).toHaveLength(1);
  expect(page.video()).toBeNull();
  expect(page.close).toBe(Object.getPrototypeOf(page).close);
  expect(context.close).toBe(Object.getPrototypeOf(context).close);
  await neutral(voiceBrowser);
  const before = await voiceBrowser.readState();
  expect(before.microphoneRequests).toBe(0);
  expect(before.clips).toEqual([]);
  await expect(access(voiceBrowser.outputDir)).rejects.toThrow();
  expect(await page.evaluate(() => navigator.userAgent)).not.toContain("stock-runner");
  expect(await page.evaluate(() => navigator.language)).not.toBe("fr-FR");
  expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
  expect(await context.cookies()).toEqual([]);
  const cdp = await context.browser().newBrowserCDPSession();
  // The stock launch explicitly enables this protocol command; the owned
  // browser must retain the pinned Chromium launch defaults instead.
  await expect(cdp.send("Browser.getBrowserCommandLine")).rejects.toThrow("--enable-automation");
  await cdp.detach();
  await context.addInitScript(() => { window.consumerOwned = true; });
  await page.goto("https://neutral.invalid/next");
  expect(page).toBe(journey);
  expect(await page.evaluate(() => window.consumerOwned)).toBe(true);
  const path = testInfo.outputPath("input.wav");
  await tone(path, 440, 0.25);
  await voiceBrowser.startRecording();
  expect((await (await voiceBrowser.playWav(path)).completed).state).toBe("completed");
  const recording = await voiceBrowser.stopRecording();
  expect(recording.state).toBe("finished");
  expect(recording.bytes).toBeGreaterThan(0);
  expect(JSON.parse(await readFile(join(voiceBrowser.outputDir, "capture.json"), "utf8")).bytes).toBe(recording.bytes);
});


test("body failure flushes active recording", async ({ voiceBrowser }, testInfo) => {
  await neutral(voiceBrowser);
  const path = testInfo.outputPath("input.wav");
  await tone(path, 440, 2);
  await voiceBrowser.startRecording();
  await voiceBrowser.playWav(path);
  await sleep(250);
  throw new Error("original-body-failure");
});

test.describe("short timeout", () => {
  test.setTimeout(500);
  const delayedSetup = test.extend({
    readiness: [async ({ voiceBrowser }, use) => {
      // A consumer's readiness work has its own setup allowance.
      await neutral(voiceBrowser);
      await voiceBrowser.startRecording();
      await sleep(750);
      await use(true);
    }, { timeout: 5000 }],
  });
  delayedSetup("short body timeout retains cleanup allowance", async ({ readiness }) => {
    expect(readiness).toBe(true);
    await sleep(3000);
  });
});

test("original failure and cleanup failure both visible", async ({ voiceBrowser }) => {
  await neutral(voiceBrowser);
  await voiceBrowser.startRecording();
  await voiceBrowser.page.close();
  throw new Error("original-before-cleanup-failure");
});

test("retry gets fresh artifacts", async ({ voiceBrowser }, testInfo) => {
  await neutral(voiceBrowser);
  await voiceBrowser.startRecording();
  await sleep(250);
  if (testInfo.retry === 0) throw new Error("retry-once");
});

for (const id of [1, 2]) {
  test(`parallel artifact ${id}`, async ({ voiceBrowser }) => {
    await neutral(voiceBrowser);
    await voiceBrowser.startRecording();
    await sleep(250);
  });
}
