import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVoiceBrowserSession } from '@meaningfool/browser-audio-testkit';
import { neutral, tone, extensionWorkerTarget } from './helpers.mjs';

await test('finish awaits accepted startup within the configured operation bound', { timeout: 60000 }, async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'audio-slow-record-start-'));
  const session = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir, operationTimeoutMs: 25000 });
  const worker = await extensionWorkerTarget(session);
  let start, finish;
  let paused = false;
  try {
    await neutral(session);
    // Pause the real browser worker at its system boundary. Startup may take
    // longer than recording flush while remaining inside the caller's bound.
    await worker.command('Debugger.enable', {});
    await worker.command('Debugger.pause', {});
    paused = true;
    start = session.startRecording();
    finish = session.stopRecording();
    void start.catch(() => {});
    void finish.catch(() => {});
    await sleep(16500);
    await worker.command('Debugger.resume', {});
    paused = false;
    assert.equal((await start).state, 'recording');
    const recording = await finish;
    assert.equal(recording.state, 'finished');
    assert.ok(recording.bytes > 0);
    assert.equal(JSON.parse(await readFile(join(outputDir, 'capture.json'), 'utf8')).state, 'finished');
    await session.close();
    assert.equal(session.page.isClosed(), true);
  } finally {
    if (paused) await worker.command('Debugger.resume', {}).catch(() => {});
    await Promise.allSettled([start, finish]);
    await worker.cdp.detach().catch(() => {});
    await session.close().catch(() => {});
    await rm(outputDir, { recursive: true, force: true });
  }
});

await test('navigation retains the page and recording while stale handles cannot stop reused IDs', { timeout: 60000 }, async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'audio-navigation-'));
  const session = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir });
  try {
    const page = session.page;
    await neutral(session);
    await tone(join(outputDir, 'tone.wav'), 440, 8);
    const old = await session.playWav(join(outputDir, 'tone.wav'), { id: 'reused' });
    const interrupted = assert.rejects(old.completed, /document|navigat|interrupt/i);
    await page.evaluate("history.pushState({}, '', '/same-document')");
    assert.equal((await old.progress()).state, 'playing');
    const start = session.startRecording();
    const finish = session.stopRecording();
    assert.equal((await start).state, 'recording');
    assert.equal((await finish).state, 'finished');
    await page.goto('https://neutral.invalid/replaced');
    await interrupted;
    assert.equal(session.page, page);
    assert.deepEqual((await session.readState()).clips, []);
    const fresh = await session.playWav(join(outputDir, 'tone.wav'), { id: 'reused' });
    await assert.rejects(old.stop(), /document|navigat|interrupt/i);
    await assert.rejects(old.progress(), /document|navigat|interrupt/i);
    assert.equal((await fresh.progress()).state, 'playing');
    await assert.rejects(session.playWav(join(outputDir, 'tone.wav'), { id: 'reused' }), /unique|duplicate|already|id/i);
    assert.equal((await fresh.stop()).state, 'stopped');
    await page.goto('about:blank');
    await assert.rejects(session.playWav(join(outputDir, 'tone.wav')), /origin/i);
    await session.stopPlayback();
    assert.equal((await session.stopRecording()).state, 'finished');
  } finally { await session.close(); await rm(outputDir, { recursive: true, force: true }); }
});

await test('active tab recording survives full document and origin changes', { timeout: 60000 }, async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'audio-record-navigation-'));
  const session = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir });
  try {
    await assert.rejects(session.startRecording(), /origin/i);
    await neutral(session);
    const page = session.page;
    const start = await session.startRecording();
    await page.goto('https://neutral.invalid/next');
    await page.evaluate(async () => {
      const context = new AudioContext(); await context.resume();
      const oscillator = context.createOscillator(); oscillator.frequency.value = 1100;
      const gain = context.createGain(); gain.gain.value = 0.1;
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start();
      window.outputAfterNavigation = { context, oscillator };
    });
    await sleep(600);
    await page.goto('about:blank');
    const finish = await session.stopRecording();
    assert.equal(finish.state, 'finished');
    assert.equal(finish.tabId, start.tabId);
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', finish.capturePath, '-f', 'f32le', '-ac', '1', '-ar', '48000', 'pipe:1'], { maxBuffer: 20_000_000 });
    const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
    let amplitude = 0;
    for (let offset = 0; offset + 4800 <= samples.length; offset += 4800) {
      let real = 0, imaginary = 0;
      for (let i = 0; i < 4800; i++) {
        real += samples[offset + i] * Math.cos(2 * Math.PI * 1100 * i / 48000);
        imaginary += samples[offset + i] * Math.sin(2 * Math.PI * 1100 * i / 48000);
      }
      amplitude = Math.max(amplitude, 2 * Math.hypot(real, imaginary) / 4800);
    }
    assert.ok(amplitude > 0.03, 'Actual capture must contain output generated only after document replacement');
    assert.equal(session.page, page);
  } finally { await session.close(); await rm(outputDir, { recursive: true, force: true }); }
});

await test('release racing accepted startup releases late resources and rejects later operations', { timeout: 60000 }, async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'audio-start-close-'));
  const profilesBefore = await readdir(tmpdir());
  const session = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir });
  try {
    await neutral(session);
    const start = session.startRecording();
    const close = session.close();
    const settlements = await Promise.allSettled([start, close]);
    assert.equal(settlements[0].status, 'fulfilled');
    assert.equal(settlements[1].status, 'fulfilled');
    assert.equal(JSON.parse(await readFile(join(outputDir, 'capture.json'), 'utf8')).state, 'finished');
    await session.close().catch(() => {});
    assert.equal(session.page.isClosed(), true);
    assert.equal(session.context.pages().length, 0);
    await assert.rejects(session.startRecording(), /clos|releas/i);
    await assert.rejects(session.readState(), /clos|releas/i);
    assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith('browser-audio-testkit-') && !profilesBefore.includes(name)), []);
  } finally { await session.close().catch(() => {}); await rm(outputDir, { recursive: true, force: true }); }
});

await test('optional recording leaves no capture artifacts even after release', { timeout: 60000 }, async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'audio-never-record-'));
  const session = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir });
  try {
    await neutral(session);
    await tone(join(outputDir, 'tone.wav'), 440, 0.3);
    const clip = await session.playWav(join(outputDir, 'tone.wav'));
    assert.equal((await clip.completed).state, 'completed');
    await session.close();
    await session.close();
    assert.deepEqual(await readdir(outputDir), ['tone.wav']);
  } finally { await session.close(); await rm(outputDir, { recursive: true, force: true }); }
});
