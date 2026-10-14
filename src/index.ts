import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { BrowserContext, Worker } from "playwright";
import { z } from "zod";
import type {
  ClipPlayback,
  RecordingMetadata,
  VoiceBrowserOptions,
  VoiceBrowserSession,
  VoiceBrowserState,
} from "./types.js";

export type {
  AudioMeter,
  ClipPlayback,
  MicrophoneTrack,
  PlayWavOptions,
  RecordingMetadata,
  VoiceBrowserOptions,
  VoiceBrowserSession,
  VoiceBrowserState,
  VoiceClip,
} from "./types.js";

const bundle = dirname(fileURLToPath(import.meta.url));
const extension = join(bundle, "extension");
const targetsSchema = z.object({
  targetInfos: z.array(
    z.object({
      targetId: z.string(),
      url: z.string(),
    }),
  ),
});
type CaptureMetadata = Omit<RecordingMetadata, "capturePath">;
type RecorderStatus =
  | CaptureMetadata
  | { state: "idle" | "starting" }
  | { state: "failed"; error: string };

async function bounded<T>(operation: Promise<T>, label: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Owns one isolated Chromium profile. The caller owns suite locking and artifact retention. */
export async function createVoiceBrowserSession(
  options: VoiceBrowserOptions,
): Promise<VoiceBrowserSession> {
  const origin = new URL(options.origin).origin;
  if (!/^https?:/.test(origin)) throw new Error("Voice browser origin must use HTTP or HTTPS");
  const timeoutMs = options.operationTimeoutMs ?? 10000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) {
    throw new Error("Voice browser operation timeout must be between 1 and 60000ms");
  }
  const outputDir = resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });
  const capturePath = join(outputDir, "capture.webm");
  const captureFile = await open(capturePath, "wx", 0o600);
  let bytesReceived = 0;
  let uploadFailure: Error | undefined;
  const uploadRoute = `/capture/${randomUUID()}`;
  let profile: string | undefined;
  let context: BrowserContext | undefined;
  let worker: Worker | undefined;
  let tabId: number | undefined;
  let started = false;
  let recording: RecordingMetadata | undefined;
  let stopPromise: Promise<RecordingMetadata> | undefined;
  let closePromise: Promise<void> | undefined;
  let disposed = false;
  let fileClosed = false;
  let browserClosed = false;
  let serverStarted = false;

  async function receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "POST" || request.url !== uploadRoute) {
        response.writeHead(404);
        response.end();
        return;
      }
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new Error("Capture upload was not a byte stream");
        bytesReceived += chunk.length;
        if (bytesReceived > 100_000_000) throw new Error("Live capture exceeded 100 MB limit");
        await captureFile.writeFile(chunk);
      }
      response.writeHead(200);
      response.end("saved");
    } catch (error) {
      uploadFailure = new Error(
        `Live capture upload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!response.headersSent) response.writeHead(500);
      response.end("capture upload failed");
    }
  }
  const server = createServer((request, response) => {
    void receive(request, response);
  });

  async function closeCaptureFile(file: FileHandle): Promise<void> {
    if (fileClosed) return;
    try {
      await file.sync();
    } finally {
      await file.close();
      fileClosed = true;
    }
  }
  async function closeServer(): Promise<void> {
    if (!serverStarted) return;
    server.closeAllConnections();
    await bounded(
      new Promise<void>((accept, reject) => {
        server.close((error) => (error ? reject(error) : accept()));
      }),
      "Capture server close",
      3000,
    );
    serverStarted = false;
  }

  try {
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        accept();
      });
    });
    serverStarted = true;
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Capture server did not bind a loopback port");
    const uploadUrl = `http://127.0.0.1:${address.port}${uploadRoute}`;
    profile = await mkdtemp(join(tmpdir(), "browser-audio-testkit-"));
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: !(options.showBrowser ?? false),
      // The suite owns signals and flushes recordings before browser process teardown.
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      timeout: 30000,
      ignoreHTTPSErrors: options.ignoreHTTPSErrors ?? false,
      ignoreDefaultArgs: ["--mute-audio"],
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "--autoplay-policy=no-user-gesture-required",
        "--enable-unsafe-extension-debugging",
      ],
    });
    context.setDefaultTimeout(timeoutMs);
    await context.addInitScript({ path: join(bundle, "page-media.js") });
    worker =
      context.serviceWorkers().find((item) => item.url().startsWith("chrome-extension://")) ??
      (await context.waitForEvent("serviceworker", {
        predicate: (item) => item.url().startsWith("chrome-extension://"),
      }));
    const page = context.pages()[0] ?? (await context.newPage());
    const browser = context.browser();
    if (!browser) throw new Error("Owned Chromium browser is unavailable");
    const ownedContext = context;
    const ownedWorker = worker;

    async function readState(): Promise<VoiceBrowserState> {
      return await bounded(
        page.evaluate<VoiceBrowserState>("window.__voiceBrowser.state()"),
        "Read voice browser state",
        timeoutMs,
      );
    }
    async function recorderStatus(): Promise<RecorderStatus> {
      return await bounded(
        ownedWorker.evaluate<RecorderStatus>("voiceRecorder.status()"),
        "Read recorder state",
        timeoutMs,
      );
    }
    async function silencePage(): Promise<void> {
      if (disposed) return;
      if (page.isClosed()) {
        disposed = true;
        return;
      }
      try {
        await bounded(page.evaluate("window.__voiceBrowser?.dispose()"), "Silence test page", 3000);
        disposed = true;
        return;
      } catch (error) {
        if (tabId === undefined) throw error;
      }
      if (tabId !== undefined) {
        await bounded(
          ownedWorker.evaluate(`chrome.tabs.update(${tabId}, { muted: true })`),
          "Mute test tab for teardown",
          3000,
        );
      }
      disposed = true;
    }
    async function stopRecording(): Promise<RecordingMetadata> {
      stopPromise ??= (async () => {
        if (!started) throw new Error("Voice tab recording has not started");
        // Chrome resumes tab playback when capture ends. Silence app sources first.
        await silencePage();
        const result = await bounded(
          ownedWorker.evaluate<CaptureMetadata>("voiceRecorder.stop()"),
          "Flush live tab recording",
          15000,
        );
        if (uploadFailure) throw uploadFailure;
        if (result.bytes !== bytesReceived || !bytesReceived)
          throw new Error("Live capture flush did not preserve every recorded byte");
        await closeCaptureFile(captureFile);
        recording = { ...result, capturePath };
        await writeFile(
          join(outputDir, "capture.json"),
          `${JSON.stringify(recording, null, 2)}\n`,
          { mode: 0o600 },
        );
        return recording;
      })();
      return await stopPromise;
    }
    async function close(): Promise<void> {
      closePromise ??= (async () => {
        const failures: string[] = [];
        try {
          await silencePage();
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
        try {
          let status = await recorderStatus();
          const startDeadline = Date.now() + 15000;
          while (status.state === "starting" && Date.now() < startDeadline) {
            await sleep(50);
            status = await recorderStatus();
          }
          if (status.state === "recording") {
            started = true;
            await stopRecording();
          } else if (status.state === "starting") {
            failures.push(
              "Capture was still starting during teardown; flush could not be established",
            );
          } else if (status.state === "failed") failures.push(status.error);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
        try {
          await bounded(ownedContext.close(), "Owned browser close", 15000);
          browserClosed = true;
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
        try {
          await closeServer();
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
        try {
          await closeCaptureFile(captureFile);
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error));
        }
        if (profile && browserClosed) {
          try {
            await rm(profile, { recursive: true, force: true });
          } catch (error) {
            failures.push(error instanceof Error ? error.message : String(error));
          }
        }
        if (failures.length)
          throw new Error(`Voice browser cleanup failed: ${failures.join("; ")}`);
      })();
      return await closePromise;
    }

    const session: VoiceBrowserSession = {
      page,
      context: ownedContext,
      browserVersion: browser.version(),
      outputDir,
      async startRecording() {
        if (started || closePromise)
          throw new Error("Voice browser recording cannot be started again");
        if (new URL(page.url()).origin !== origin)
          throw new Error("Navigate the owned page to the configured origin before recording");
        await page.bringToFront();
        const tab = await bounded(
          ownedWorker.evaluate<{ id: number } | undefined>(
            // URL is protected before activeTab is granted on named HTTPS origins.
            // bringToFront identifies the intended active tab without requesting tabs permission.
            "chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => tabs[0])",
          ),
          "Identify voice tab",
          timeoutMs,
        );
        if (!tab || !Number.isInteger(tab.id))
          throw new Error("Recorder extension cannot identify the owned tab");
        tabId = tab.id;
        await bounded(
          ownedWorker.evaluate(
            `voiceRecorder.prepare(${JSON.stringify({ tabId, uploadUrl, listenLive: options.listenLive ?? false })})`,
          ),
          "Prepare live tab recorder",
          timeoutMs,
        );
        if (closePromise) throw new Error("Voice browser is closing before capture activation");
        const cdp = await browser.newBrowserCDPSession();
        try {
          const targets = targetsSchema.parse(
            await cdp.send("Target.getTargets", {
              filter: [{ type: "tab", exclude: false }],
            }),
          );
          const target = targets.targetInfos.find((item) => item.url === page.url());
          if (!target) throw new Error("No Chromium tab target matches the owned page");
          if (closePromise) throw new Error("Voice browser is closing before capture activation");
          // A real extension action grants activeTab; invoking the JS listener does not.
          await bounded(
            cdp.send("Extensions.triggerAction", {
              id: new URL(ownedWorker.url()).hostname,
              targetId: target.targetId,
            }),
            "Activate live tab capture (requires full Chromium 153+)",
            timeoutMs,
          );
        } finally {
          await cdp.detach();
        }
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const status = await recorderStatus();
          if (status.state === "failed") throw new Error(status.error);
          if (status.state === "recording") {
            started = true;
            recording = { ...status, capturePath };
            const captured = await bounded(
              ownedWorker.evaluate<{ tabId: number; status: string }[]>(
                "chrome.tabCapture.getCapturedTabs()",
              ),
              "Verify live tab capture",
              timeoutMs,
            );
            if (!captured.some((item) => item.tabId === tabId && item.status === "active")) {
              throw new Error("Chromium has not activated the owned tab's audio capture");
            }
            if (recording.monitorConnected !== (options.listenLive ?? false)) {
              throw new Error("Tab capture monitoring does not match the requested listening mode");
            }
            return recording;
          }
          await sleep(50);
        }
        throw new Error("Extension action did not start live tab recording within 15000ms");
      },
      async playWav(path, clipOptions = {}) {
        if (!started || stopPromise || closePromise)
          throw new Error("Start live tab capture before playing a WAV clip");
        const id = clipOptions.id ?? randomUUID();
        const base64 = (await readFile(path)).toString("base64");
        const clip = await bounded(
          page.evaluate<ClipPlayback>(
            `window.__voiceBrowser.playWav(${JSON.stringify({
              id,
              base64,
              requireLiveMicrophone: clipOptions.requireLiveMicrophone ?? false,
            })})`,
          ),
          "Start synthetic microphone clip",
          timeoutMs,
        );
        const completed = bounded(
          page.evaluate<ClipPlayback>(`window.__voiceBrowser.completed(${JSON.stringify(id)})`),
          "Complete synthetic voice clip",
          Math.ceil(clip.durationSeconds * 1000) + 10000,
        );
        // Teardown can reject this pending evaluation; callers still observe the original promise.
        void completed.catch(() => undefined);
        return {
          id,
          durationSeconds: clip.durationSeconds,
          startedAtUnixMs: clip.startedAtUnixMs,
          startedAudioContextSeconds: clip.startedAudioContextSeconds,
          completed,
          async progress() {
            return await bounded(
              page.evaluate<ClipPlayback>(`window.__voiceBrowser.clip(${JSON.stringify(id)})`),
              "Read voice clip progress",
              timeoutMs,
            );
          },
          async stop() {
            return await bounded(
              page.evaluate<ClipPlayback>(`window.__voiceBrowser.stopClip(${JSON.stringify(id)})`),
              "Stop voice clip",
              timeoutMs,
            );
          },
        };
      },
      readState,
      async stopPlayback() {
        return await bounded(
          page.evaluate<VoiceBrowserState>("window.__voiceBrowser.stopPlayback()"),
          "Stop synthetic voice playback",
          timeoutMs,
        );
      },
      stopRecording,
      close,
    };
    return session;
  } catch (error) {
    const failures = [error instanceof Error ? error.message : String(error)];
    if (context) {
      try {
        await bounded(context.close(), "Failed browser setup cleanup", 15000);
        browserClosed = true;
      } catch (cleanupError) {
        failures.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      }
    }
    try {
      await closeServer();
    } catch (cleanupError) {
      failures.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
    try {
      await closeCaptureFile(captureFile);
    } catch (cleanupError) {
      failures.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
    if (profile && (!context || browserClosed)) {
      try {
        await rm(profile, { recursive: true, force: true });
      } catch (cleanupError) {
        failures.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
      }
    }
    throw new Error(failures.join("; "), { cause: error });
  }
}
