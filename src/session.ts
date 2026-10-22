import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "./isolated-playwright.js";
import type { BrowserContext, JSHandle } from "playwright";
import type {
  ClipPlayback,
  RecordingStarted,
  RecordingFinished,
  VoiceBrowserSession,
  VoiceBrowserOptions,
  VoiceBrowserState,
} from "./types.js";
const bundle = dirname(fileURLToPath(import.meta.url));
async function bounded<T>(
  operation: Promise<T>,
  label: string,
  timeout: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${timeout}ms`)),
          timeout,
        );
      }),
    ]);
  } catch (cause) {
    throw new Error(
      `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Owns one isolated Chromium profile, one tab and an optional recording interval. */
export async function createSession(
  options: VoiceBrowserOptions,
  preparationTimeoutMs?: number,
): Promise<VoiceBrowserSession> {
  const preparationDeadline = preparationTimeoutMs === undefined
    ? Infinity : Date.now() + preparationTimeoutMs;
  function preparationBudget(limit: number) {
    const remaining = Math.ceil(preparationDeadline - Date.now());
    if (remaining <= 0) throw new Error("Voice browser preparation deadline exceeded");
    return Math.min(limit, remaining);
  }
  function prepare<T>(operation: Promise<T>, label: string, limit?: number) {
    // Preserve the explicit API's existing setup timing. Only the fixture
    // supplies an aggregate deadline; previously bounded stages pass a limit.
    if (limit === undefined && preparationTimeoutMs === undefined)
      return operation;
    // Observe already-started operations even if the deadline has just elapsed.
    return bounded(operation, label, Math.max(1, Math.min(
      limit ?? Infinity,
      preparationDeadline - Date.now(),
    )));
  }
  const origin = new URL(options.origin).origin;
  if (!/^https?:/.test(origin))
    throw new Error("Voice browser origin must use HTTP or HTTPS");
  const captureInput = options.captureInput ?? "reference";
  if (captureInput !== "reference" && captureInput !== "microphone")
    throw new Error("Voice browser capture input must be reference or microphone");
  const timeout = options.operationTimeoutMs ?? 10000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 60000)
    throw new Error(
      "Voice browser operation timeout must be between 1 and 60000ms",
    );
  const outputDir = resolve(options.outputDir);
  const capturePath = join(outputDir, "capture.webm");
  let captureFile: FileHandle | undefined;
  let metadataFile: FileHandle | undefined;
  let bytesReceived = 0;
  let uploadFailure: Error | undefined;
  let profile: string | undefined;
  let context: BrowserContext | undefined;
  let browserClosed = false;
  let serverStarted = false;
  const uploadRoute = `/capture/${randomUUID()}`;
  const bootstrapRoute = `/bootstrap/${randomUUID()}`;
  const server = createServer((request, response) => {
    void (async () => {
      try {
        if (request.method === "GET" && request.url === bootstrapRoute) {
          response.writeHead(200, { "Content-Type": "text/html" });
          response.end(
            "<!doctype html><title>Browser audio preparation</title>",
          );
          return;
        }
        if (
          request.method !== "POST" ||
          request.url !== uploadRoute ||
          !captureFile
        ) {
          response.writeHead(404);
          response.end();
          return;
        }
        for await (const chunk of request) {
          if (!Buffer.isBuffer(chunk))
            throw new Error("Capture upload was not a byte stream");
          if (bytesReceived + chunk.length > 100_000_000)
            throw new Error("Live capture exceeded 100 MB limit");
          await captureFile.writeFile(chunk);
          bytesReceived += chunk.length;
        }
        response.writeHead(200);
        response.end("saved");
      } catch (cause) {
        uploadFailure = new Error(`Live capture upload failed: ${cause}`, {
          cause,
        });
        if (!response.headersSent) response.writeHead(500);
        response.end("capture upload failed");
      }
    })();
  });
  async function closeFiles() {
    const failures: unknown[] = [];
    for (const file of [captureFile, metadataFile])
      if (file) {
        try {
          await bounded(file.close(), "Close capture file", 3000);
        } catch (error) {
          failures.push(error);
        }
      }
    captureFile = undefined;
    metadataFile = undefined;
    if (failures.length)
      throw new AggregateError(failures, "Close capture files failed");
  }
  async function closeServer() {
    if (!serverStarted) return;
    server.closeAllConnections();
    await bounded(
      new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      ),
      "Capture server close",
      3000,
    );
    serverStarted = false;
  }
  try {
    await prepare(
      new Promise<void>((accept, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          serverStarted = true;
          accept();
        });
      }),
      "Capture server startup",
      timeout,
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Capture server did not bind a loopback port");
    const serverOrigin = `http://127.0.0.1:${address.port}`;
    profile = await mkdtemp(join(tmpdir(), "browser-audio-testkit-"));
    const extension = join(bundle, "extension");
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: !(options.showBrowser ?? false),
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      timeout: preparationBudget(30000),
      ignoreHTTPSErrors: options.ignoreHTTPSErrors ?? false,
      ignoreDefaultArgs: ["--mute-audio"],
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "--autoplay-policy=no-user-gesture-required",
        "--enable-unsafe-extension-debugging",
      ],
    });
    const ownedContext = context;
    context.setDefaultTimeout(timeout);
    const microphoneScript = await readFile(join(bundle, "page-media.js"), "utf8");
    await prepare(context.addInitScript({
      content: `${microphoneScript}(${JSON.stringify(captureInput)});`,
    }), "Prepare microphone script");
    const worker =
      context
        .serviceWorkers()
        .find((item) => item.url().startsWith("chrome-extension://")) ??
      (await context.waitForEvent("serviceworker", {
        predicate: (item) => item.url().startsWith("chrome-extension://"),
        timeout: preparationBudget(timeout),
      }));
    const page = context.pages()[0] ?? (await prepare(context.newPage(), "Create owned page"));
    const browser = context.browser();
    if (!browser) throw new Error("Owned Chromium browser is unavailable");
    await page.goto(serverOrigin + bootstrapRoute, { timeout: preparationBudget(timeout) });
    await prepare(page.bringToFront(), "Activate owned page");
    const tab = await prepare(worker.evaluate<{ id: number }>(
      "chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => tabs[0])",
    ), "Identify owned tab");
    if (!Number.isInteger(tab?.id))
      throw new Error("Cannot identify owned capture tab");
    await prepare(worker.evaluate(
      `voiceRecorder.prepare(${JSON.stringify({ tabId: tab.id, listenLive: options.listenLive ?? false })})`,
    ), "Prepare capture routing");
    const cdp = await prepare(browser.newBrowserCDPSession(), "Connect capture activation");
    try {
      const { targetInfos } = await prepare(cdp.send("Target.getTargets", {
        filter: [{ type: "tab", exclude: false }],
      }), "Identify capture target");
      const target = targetInfos.find((item) => item.url === page.url());
      if (!target) throw new Error("No Chromium tab target matches owned page");
      await prepare(
        cdp.send("Extensions.triggerAction", {
          id: new URL(worker.url()).hostname,
          targetId: target.targetId,
        }),
        "Activate live tab capture (requires full Chromium 153+)",
        15000,
      );
    } finally {
      await prepare(cdp.detach(), "Disconnect capture activation");
    }
    type RoutingStatus = {
      state: string;
      error?: string;
      monitorConnected?: boolean;
    };
    const status = () =>
      bounded(
        worker.evaluate<RoutingStatus>("voiceRecorder.status()"),
        "Read capture routing",
        timeout,
      );
    const deadline = Math.min(Date.now() + 15000, preparationDeadline);
    while (true) {
      const current = await prepare(status(), "Await live capture routing");
      if (current.state === "failed") throw new Error(current.error);
      if (current.state === "ready") break;
      if (Date.now() >= deadline)
        throw new Error("Live capture activation exceeded 15000ms");
      await sleep(50);
    }
    const captured = await prepare(worker.evaluate<{ tabId: number; status: string }[]>(
      "chrome.tabCapture.getCapturedTabs()",
    ), "Verify active capture");
    if (
      !captured.some(
        (item) => item.tabId === tab.id && item.status === "active",
      )
    )
      throw new Error(
        "Chromium has not activated the owned tab's audio capture",
      );
    let environment: "ready" | "failed" | "closing" | "closed" = "ready";
    let environmentFailure: Error | undefined;
    let startPromise: Promise<RecordingStarted> | undefined;
    let stopPromise: Promise<RecordingFinished> | undefined;
    let closePromise: Promise<void> | undefined;
    let recordingState:
      | "idle"
      | "starting"
      | "recording"
      | "finishing"
      | "finished"
      | "failed" = "idle";
    let recordingFailure: unknown;
    let finished: RecordingFinished | undefined;
    function lost(message: string) {
      if (environment !== "ready") return;
      environment = "failed";
      environmentFailure = new Error(message);
      void worker
        .evaluate(`chrome.tabs.update(${tab.id}, { muted: true })`)
        .catch(() => page.close().catch(() => undefined));
    }
    page.on("close", () =>
      lost("Owned page closed unexpectedly; live capture was interrupted"),
    );
    context.on("close", () =>
      lost("Owned context closed unexpectedly; live capture was interrupted"),
    );
    function ready(label: string) {
      if (environment !== "ready")
        throw new Error(`${label}: environment is ${environment}`, {
          cause: environmentFailure,
        });
    }
    async function available(label: string) {
      if (environment !== "ready")
        throw new Error(`${label}: environment is ${environment}`, {
          cause: environmentFailure,
        });
      const current = await status();
      if (current.state === "failed") {
        lost(current.error ?? "Live capture lost");
        throw environmentFailure;
      }
      ready(label);
    }
    function atOrigin(label: string) {
      if (new URL(page.url()).origin !== origin)
        throw new Error(
          `${label}: navigate the owned page to the configured origin`,
        );
    }
    async function startRecording(): Promise<RecordingStarted> {
      ready("Start recording");
      atOrigin("Start recording");
      if (recordingState !== "idle")
        throw new Error("Voice browser recording cannot be started again");
      // Set accepted startup synchronously before allocating any artifacts.
      recordingState = "starting";
      startPromise = (async () => {
        try {
          const routing = await status();
          if (routing.state === "failed") {
            lost(routing.error ?? "Live capture lost");
            throw new Error(routing.error ?? "Live capture lost");
          }
          await mkdir(outputDir, { recursive: true });
          metadataFile = await open(
            join(outputDir, "capture.json"),
            "wx",
            0o600,
          );
          captureFile = await open(capturePath, "wx", 0o600);
          const result = await bounded(
            worker.evaluate<Omit<RecordingStarted, "capturePath" | "captureInput">>(
              `voiceRecorder.start(${JSON.stringify(serverOrigin + uploadRoute)})`,
            ),
            "Start live tab recording",
            15000,
          );
          recordingState = "recording";
          return { ...result, capturePath, captureInput };
        } catch (error) {
          recordingState = "failed";
          recordingFailure = error;
          throw error;
        }
      })();
      return await startPromise;
    }
    async function stopRecording(): Promise<RecordingFinished> {
      if (!startPromise) throw new Error("Voice tab recording has not started");
      stopPromise ??= (async () => {
        try {
          // During release, pending startup and finalization share the same
          // allowance so context/server cleanup still has time to run.
          const releasing = environment === "closing";
          let finishDeadline = Date.now() + 15000;
          if (releasing) await bounded(startPromise, "Await recording startup", 15000);
          else await startPromise;
          if (!releasing) finishDeadline = Date.now() + 15000;
          recordingState = "finishing";
          const finalize = <T>(operation: Promise<T>, label: string, limit: number) =>
            bounded(operation, label, Math.max(1, Math.min(limit, finishDeadline - Date.now())));
          const result = await finalize(
            worker.evaluate<Omit<RecordingFinished, "capturePath" | "captureInput">>(
              "voiceRecorder.stop()",
            ),
            "Flush live tab recording",
            15000,
          );
          if (environmentFailure) throw environmentFailure;
          if (uploadFailure) throw uploadFailure;
          if (!bytesReceived || result.bytes !== bytesReceived)
            throw new Error(
              "Live capture flush did not preserve every recorded byte",
            );
          if (!captureFile || !metadataFile)
            throw new Error("Recording files unavailable");
          await finalize(captureFile.sync(), "Sync capture", 3000);
          await finalize(captureFile.close(), "Close capture", 3000);
          captureFile = undefined;
          const recording: RecordingFinished = { ...result, capturePath, captureInput };
          await finalize(
            metadataFile.writeFile(`${JSON.stringify(recording, null, 2)}\n`),
            "Persist capture metadata",
            3000,
          );
          await finalize(metadataFile.sync(), "Sync capture metadata", 3000);
          await finalize(metadataFile.close(), "Close capture metadata", 3000);
          metadataFile = undefined;
          recordingState = "finished";
          finished = recording;
          return recording;
        } catch (error) {
          recordingState = "failed";
          recordingFailure = error;
          throw error;
        }
      })();
      return await stopPromise;
    }
    async function close(): Promise<void> {
      closePromise ??= (async () => {
        environment = "closing";
        const failures: unknown[] = [];
        const attempt = async (operation: () => Promise<unknown>) => {
          try {
            await operation();
          } catch (error) {
            failures.push(error);
          }
        };
        // Stop extension monitoring as well as native playback before flushing.
        await attempt(() =>
          bounded(
            worker.evaluate("voiceRecorder.silence()"),
            "Silence live monitor",
            3000,
          ),
        );
        // Mute stays in force through capture release, including navigation and missing instrumentation.
        if (!page.isClosed()) {
          await attempt(() =>
            bounded(
              worker.evaluate(`chrome.tabs.update(${tab.id}, { muted: true })`),
              "Mute owned tab",
              3000,
            ),
          );
          await attempt(() =>
            bounded(
              page.evaluate("window.__voiceBrowser?.dispose()"),
              "Silence owned page",
              3000,
            ),
          );
        }
        if (startPromise && !finished)
          await attempt(() => bounded(stopRecording(), "Finalize recording during cleanup", 15000));
        else if (recordingFailure) failures.push(recordingFailure);
        if (environmentFailure) failures.push(environmentFailure);
        await attempt(() =>
          bounded(
            worker.evaluate("voiceRecorder.release()"),
            "Release tab capture",
            3000,
          ),
        );
        await attempt(async () => {
          await bounded(ownedContext.close(), "Owned browser close", 15000);
          browserClosed = true;
        });
        await attempt(closeServer);
        await attempt(closeFiles);
        if (profile && browserClosed)
          await attempt(() => bounded(rm(profile!, { recursive: true, force: true }), "Remove browser profile", 3000));
        environment = "closed";
        if (failures.length)
          throw new AggregateError(
            failures,
            `Voice browser cleanup failed: ${failures.map(String).join("; ")}`,
          );
      })();
      return await closePromise;
    }
    return {
      page,
      context: ownedContext,
      outputDir,
      browserVersion: browser.version(),
      startRecording,
      stopRecording,
      close,
      async readState() {
        await available("Read state");
        return bounded(
          page.evaluate<VoiceBrowserState>("window.__voiceBrowser.state()"),
          "Read voice browser state",
          timeout,
        );
      },
      async stopPlayback() {
        await available("Stop playback");
        return bounded(
          page.evaluate<VoiceBrowserState>(
            "window.__voiceBrowser.stopPlayback()",
          ),
          "Stop synthetic voice playback",
          timeout,
        );
      },
      async playWav(path, clipOptions = {}) {
        await available("Play WAV");
        atOrigin("Play WAV");
        const base64 = (
          await bounded(readFile(path), "Read WAV", timeout)
        ).toString("base64");
        await available("Play WAV");
        atOrigin("Play WAV");
        // A JSHandle is bound to one execution context: it cannot address reused IDs after navigation.
        const pendingDocument = page.evaluateHandle("window.__voiceBrowser");
        const document = (await bounded(
          pendingDocument,
          "Prepare microphone playback document",
          timeout,
        ).catch((error) => {
          // A late evaluation may still allocate a handle after the caller times out.
          void pendingDocument.then((handle) => handle.dispose()).catch(() => undefined);
          throw error;
        })) as JSHandle<{
          playWav(input: {
            id: string;
            base64: string;
            requireLiveMicrophone: boolean;
          }): Promise<ClipPlayback>;
          completed(id: string): Promise<ClipPlayback>;
          clip(id: string): ClipPlayback;
          stopClip(id: string): ClipPlayback;
        }>;
        ready("Play WAV");
        const id = clipOptions.id ?? randomUUID();
        const clip = await bounded(
          document.evaluate<
            ClipPlayback,
            { id: string; base64: string; requireLiveMicrophone: boolean }
          >((audio, input) => audio.playWav(input), {
            id,
            base64,
            requireLiveMicrophone: clipOptions.requireLiveMicrophone ?? false,
          }),
          "Start synthetic microphone clip",
          timeout,
        );
        const completed = bounded(
          document.evaluate<ClipPlayback, string>(
            (audio, id) => audio.completed(id),
            id,
          ),
          "Complete synthetic voice clip (document interruption possible)",
          Math.ceil(clip.durationSeconds * 1000) + 10000,
        );
        void completed.catch(() => undefined);
        return {
          id,
          durationSeconds: clip.durationSeconds,
          startedAtUnixMs: clip.startedAtUnixMs,
          startedAudioContextSeconds: clip.startedAudioContextSeconds,
          completed,
          async progress() {
            await available("Read clip progress");
            return bounded(
              document.evaluate<ClipPlayback, string>(
                (audio, id) => audio.clip(id),
                id,
              ),
              "Read clip progress (document interruption possible)",
              timeout,
            );
          },
          async stop() {
            await available("Stop clip");
            return bounded(
              document.evaluate<ClipPlayback, string>(
                (audio, id) => audio.stopClip(id),
                id,
              ),
              "Stop clip (document interruption possible)",
              timeout,
            );
          },
        };
      },
    };
  } catch (cause) {
    const failures: unknown[] = [cause];
    const attempt = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    if (context)
      await attempt(async () => {
        await bounded(context!.close(), "Failed setup browser cleanup", 15000);
        browserClosed = true;
      });
    await attempt(closeServer);
    await attempt(closeFiles);
    if (profile && (!context || browserClosed))
      await attempt(() => bounded(rm(profile!, { recursive: true, force: true }), "Remove browser profile", 3000));
    throw new AggregateError(
      failures,
      `Voice browser setup failed: ${failures.map(String).join("; ")}`,
      { cause },
    );
  }
}
