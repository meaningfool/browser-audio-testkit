// The controller supplies a tab ID and recording destination, never audio fixtures.
let prepared;
let status = { state: "idle" };

async function start(tab) {
  try {
    if (!prepared || tab.id !== prepared.tabId) throw new Error("Unexpected capture tab");
    status = { state: "starting", tabId: tab.id };
    await chrome.offscreen.createDocument({
      url: "recorder.html",
      reasons: ["USER_MEDIA"],
      justification: "Record the isolated browser audio test tab's live audio",
    });
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const result = await chrome.runtime.sendMessage({
      target: "recorder",
      type: "start",
      streamId,
      ...prepared,
    });
    if (!result?.ok) throw new Error(result?.error || "Recorder did not acknowledge start");
    status = { state: "recording", ...result.metadata };
  } catch (error) {
    status = { state: "failed", error: String(error) };
  }
}
chrome.action.onClicked.addListener((tab) => void start(tab));

globalThis.voiceRecorder = {
  prepare(options) {
    if (status.state !== "idle") throw new Error("Capture has already been requested");
    prepared = options;
    return true;
  },
  status() {
    return status;
  },
  async stop() {
    if (status.state === "finished") return status;
    if (status.state !== "recording") throw new Error(`Cannot stop recorder: ${status.state}`);
    const result = await chrome.runtime.sendMessage({ target: "recorder", type: "stop" });
    if (!result?.ok) throw new Error(result?.error || "Recorder did not acknowledge flush");
    status = { state: "finished", ...result.metadata };
    await chrome.offscreen.closeDocument();
    return status;
  },
};
