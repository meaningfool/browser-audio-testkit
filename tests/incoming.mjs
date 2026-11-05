import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVoiceBrowserSession } from '@meaningfool/browser-audio-testkit';
import { neutral } from './helpers.mjs';

await test('incoming playing events are counted once from document start', { timeout: 60000 }, async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'audio-incoming-playing-'));
  const session = await createVoiceBrowserSession({ origin: 'https://neutral.invalid', outputDir });
  try {
    const page = session.page;
    await neutral(session);
    await page.evaluate(async () => {
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      const output = context.createMediaStreamDestination();
      oscillator.connect(output);
      oscillator.start();
      const observed = { audio: 0, video: 0 };
      const element = (tag) => {
        const media = document.createElement(tag);
        media.addEventListener('playing', () => observed[tag]++);
        media.srcObject = output.stream;
        return media;
      };
      window.incomingVerification = { observed, element, ready: (media) => new Promise((resolve) => {
        if (media.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) resolve();
        else media.addEventListener('canplaythrough', resolve, { once: true });
      }) };
    });
    // Like an application that creates, attaches and starts its output in one step,
    // playback begins before any later sample can discover the new element.
    await page.evaluate(async () => {
      const { element, ready } = window.incomingVerification;
      const early = element('audio');
      await ready(early);
      document.body.append(early);
      await early.play();
      window.incomingVerification.early = early;
    });
    assert.equal((await session.readState()).incoming.playingEvents, 1);

    // An element already present before it plays keeps being counted.
    await page.evaluate(() => {
      const known = window.incomingVerification.element('audio');
      document.body.append(known);
      window.incomingVerification.known = known;
    });
    assert.equal((await session.readState()).incoming.playingEvents, 1);
    await page.evaluate(async () => {
      const { known, early } = window.incomingVerification;
      await known.play();
      early.pause();
      await early.play();
    });
    // Video output is outside the observed <audio> scope.
    await page.evaluate(async () => {
      const { element, ready } = window.incomingVerification;
      const video = element('video');
      await ready(video);
      document.body.append(video);
      await video.play();
    });
    const observed = await page.evaluate(() => window.incomingVerification.observed);
    assert.deepEqual(observed, { audio: 3, video: 1 });
    assert.equal((await session.readState()).incoming.playingEvents, 3);
  } finally {
    await session.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});
