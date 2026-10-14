// Capture routing lives for the environment; saving is one independent interval.
let prepared;
let status = { state: "idle" };
let releasing = false;
async function command(type, options = {}) {
  const result = await chrome.runtime.sendMessage({
    target: "recorder",
    type,
    ...options,
  });
  if (!result?.ok)
    throw new Error(result?.error || `Recorder did not acknowledge ${type}`);
  return result.metadata;
}
async function captureLost() {
  if (releasing || status.state === "failed") return;
  status = { state: "failed", error: "Live tab capture was lost" };
  // Capture loss restores native tab playback: suppress it independently of page instrumentation.
  try {
    await chrome.tabs.update(prepared.tabId, { muted: true });
  } catch {
    try {
      await chrome.tabs.remove(prepared.tabId);
    } catch {}
  }
}
chrome.runtime.onMessage.addListener((message) => {
  if (message.target === "controller" && message.type === "captureLost")
    void captureLost();
});
chrome.tabCapture.onStatusChanged.addListener((info) => {
  if (
    info.tabId === prepared?.tabId &&
    ["stopped", "error"].includes(info.status)
  )
    void captureLost();
});
async function activate(tab) {
  try {
    if (!prepared || tab.id !== prepared.tabId)
      throw new Error("Unexpected capture tab");
    status = { state: "starting" };
    await chrome.offscreen.createDocument({
      url: "recorder.html",
      reasons: ["USER_MEDIA"],
      justification: "Route the isolated browser audio test tab",
    });
    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });
    const result = await command("activate", { streamId, ...prepared });
    if (status.state !== "failed") status = { state: "ready", ...result };
  } catch (error) {
    status = { state: "failed", error: String(error) };
  }
}
chrome.action.onClicked.addListener((tab) => void activate(tab));
globalThis.voiceRecorder = {
  prepare(options) {
    if (status.state !== "idle") throw new Error("Capture already requested");
    prepared = options;
  },
  status() {
    return status;
  },
  async start(uploadUrl) {
    if (status.state !== "ready")
      throw new Error(`Cannot start recorder: ${status.state}`);
    try {
      const result = await command("start", { ...prepared, uploadUrl });
      if (status.state === "failed") throw new Error(status.error);
      return { state: "recording", ...result };
    } catch (error) {
      throw new Error(`Start recording failed: ${error}`);
    }
  },
  async stop() {
    const result = await command("stop");
    if (status.state === "failed") throw new Error(status.error);
    return { state: "finished", ...result };
  },
  async silence() {
    await command("silence");
  },
  async release() {
    releasing = true;
    try {
      await command("release");
    } finally {
      await chrome.offscreen.closeDocument();
    }
  },
};
