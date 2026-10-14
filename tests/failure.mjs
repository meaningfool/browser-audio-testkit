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

await test('failed capture file allocation is terminal and repeated finish/release preserve failure', { timeout: 60000 }, async () => {
  const { mkdir, readFile } = await import('node:fs/promises');
  const outputDir = await mkdtemp(join(tmpdir(), 'audio-file-failure-'));
  const session = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir });
  try {
    await session.context.route('https://neutral.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await session.page.goto('https://neutral.invalid/');
    await mkdir(join(outputDir, 'capture.webm'));
    await assert.rejects(session.startRecording(), /EEXIST|exist|directory/i);
    const finishes = await Promise.allSettled([session.stopRecording(), session.stopRecording()]);
    assert.equal(finishes[0].status, 'rejected');
    assert.equal(finishes[1].status, 'rejected');
    assert.equal(finishes[0].reason, finishes[1].reason);
    assert.match(String(finishes[0].reason), /EEXIST|exist|directory|record/i);
    await assert.rejects(session.startRecording(), /record/i);
    assert.equal((await session.readState()).disposed, false, 'File failure must leave healthy audio routing usable');
    assert.equal(await readFile(join(outputDir, 'capture.json'), 'utf8'), '', 'Allocated metadata must not certify a failed start');
    const closes = await Promise.allSettled([session.close(), session.close()]);
    assert.equal(closes[0].status, 'rejected');
    assert.equal(closes[1].status, 'rejected');
    assert.equal(closes[0].reason, closes[1].reason);
    assert.equal(session.page.isClosed(), true);
    assert.equal(session.context.pages().length, 0);
  } finally { await session.close().catch(() => {}); await rm(outputDir, { recursive: true, force: true }); }
});

await test('unexpected native tab closure rejects normal finish and still releases resources', { timeout: 60000 }, async () => {
  const { readFile } = await import('node:fs/promises');
  const outputDir = await mkdtemp(join(tmpdir(), 'audio-tab-loss-'));
  const session = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir });
  try {
    await session.context.route('https://neutral.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await session.page.goto('https://neutral.invalid/');
    await session.startRecording();
    await session.page.close();
    const finishes = await Promise.allSettled([session.stopRecording(), session.stopRecording()]);
    assert.equal(finishes[0].status, 'rejected');
    assert.equal(finishes[1].status, 'rejected');
    assert.equal(finishes[0].reason, finishes[1].reason);
    await assert.rejects(session.close());
    await assert.rejects(session.close());
    assert.equal(session.context.pages().length, 0);
    const metadata = await readFile(join(outputDir, 'capture.json'), 'utf8').then(raw => raw.trim() ? JSON.parse(raw) : null, () => null);
    assert.notEqual(metadata?.state, 'finished', 'Recovered partial capture must not be certified complete');
  } finally { await session.close().catch(() => {}); await rm(outputDir, { recursive: true, force: true }); }
});

await test('consumer capture collision is rejected without overwriting evidence', { timeout: 60000 }, async () => {
  const { writeFile, readFile } = await import('node:fs/promises');
  const outputDir = await mkdtemp(join(tmpdir(), 'audio-collision-'));
  const session = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir });
  try {
    await session.context.route('https://neutral.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await session.page.goto('https://neutral.invalid/');
    await writeFile(join(outputDir, 'capture.webm'), 'previous capture');
    await assert.rejects(session.startRecording(), /exist|collision|capture/i);
    assert.equal(await readFile(join(outputDir, 'capture.webm'), 'utf8'), 'previous capture');
  } finally { await session.close().catch(() => {}); await rm(outputDir, { recursive: true, force: true }); }
});

await test('actual capture upload failure cannot certify a finished recording', { timeout: 60000 }, async () => {
  const { captureTarget } = await import('./helpers.mjs');
  const { readFile } = await import('node:fs/promises');
  const outputDir = await mkdtemp(join(tmpdir(), 'audio-upload-loss-'));
  const session = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir });
  const recorder = await captureTarget(session);
  try {
    await session.context.route('https://neutral.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }));
    await session.page.goto('https://neutral.invalid/');
    // Browser network fault at the upload boundary; real MediaRecorder chunks
    // still originate in native tab capture and must fail rather than be rebuilt.
    await recorder.command('Network.enable', {});
    await recorder.command('Network.setBlockedURLs', { urls: ['http://127.0.0.1:*/*'] });
    await session.startRecording();
    const finishes = await Promise.allSettled([session.stopRecording(), session.stopRecording()]);
    assert.equal(finishes[0].status, 'rejected');
    assert.equal(finishes[1].status, 'rejected');
    assert.equal(finishes[0].reason, finishes[1].reason);
    assert.match(String(finishes[0].reason), /fetch|upload|record|network/i);
    assert.equal((await session.readState()).disposed, false);
    const metadata = await readFile(join(outputDir, 'capture.json'), 'utf8').then(raw => raw.trim() ? JSON.parse(raw) : null, () => null);
    assert.notEqual(metadata?.state, 'finished');
    await assert.rejects(session.close());
    assert.equal(session.page.isClosed(), true);
  } finally { await recorder.cdp.detach().catch(() => {}); await session.close().catch(() => {}); await rm(outputDir, { recursive: true, force: true }); }
});
