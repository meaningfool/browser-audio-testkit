import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
export async function tone(path, frequency = 440, seconds = 2) {
  const rate = 48000, samples = Math.round(rate * seconds);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + 2 * i);
  await writeFile(path, wav);
}
export async function waitFor(read, predicate, message) {
  const deadline = Date.now() + 5000;
  let value;
  do { value = await read(); if (predicate(value)) return value; await sleep(50); } while (Date.now() < deadline);
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}
export async function neutral(session, body = '<!doctype html><body></body>') {
  await session.context.route('https://neutral.invalid/**', route => route.fulfill({ contentType: 'text/html', body }));
  await session.page.goto('https://neutral.invalid/');
}
export async function captureTarget(session) {
  return extensionTarget(session, 'background_page', '/recorder.html');
}
export async function extensionWorkerTarget(session) {
  return extensionTarget(session, 'service_worker', '/background.js');
}
async function extensionTarget(session, type, path) {
  const cdp = await session.context.browser().newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  const target = targetInfos.find(item => item.type === type && item.url.startsWith('chrome-extension://') && item.url.endsWith(path));
  if (!target) throw new Error(`Chromium must expose the active extension target ${path}`);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let sequence = 0;
  return { cdp, target, async command(method, params) {
    const id = ++sequence;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', listener); reject(new Error(`CDP ${method} timed out`)); }, 5000);
      const listener = event => {
        if (event.sessionId !== sessionId) return;
        const message = JSON.parse(event.message);
        if (message.id !== id) return;
        clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', listener);
        if (message.error || message.result.exceptionDetails) reject(new Error(JSON.stringify(message)));
        else resolve(message.result);
      };
      cdp.on('Target.receivedMessageFromTarget', listener);
    });
    await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
    return result;
  }, async evaluate(expression) { return (await this.command('Runtime.evaluate', { expression, returnByValue: true })).result.value; } };
}
