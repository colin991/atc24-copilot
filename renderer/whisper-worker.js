// Built-in speech to text, used when the fast online one isn't available.
// Runs Whisper (English) on this PC in a background thread. The model
// downloads once from Hugging Face the first time it's needed:
//   accurate = whisper-small.en (~250 MB, better with numbers, ~2x slower)
//   fast     = whisper-base.en  (~80 MB)
import { pipeline, env } from "../node_modules/@huggingface/transformers/dist/transformers.min.js";

env.allowLocalModels = false;
const MODELS = { accurate: "onnx-community/whisper-small.en", fast: "onnx-community/whisper-base.en" };
let asr = null, loaded = null;

self.onmessage = async (e) => {
  const { id, audio, quality = "accurate" } = e.data;
  const model = MODELS[quality] || MODELS.accurate;
  try {
    if (!asr || loaded !== model) {
      self.postMessage({ status: "loading", quality });
      asr = null;
      // The graphics card is much faster; fall back to the CPU if there isn't one.
      if (self.navigator?.gpu && (await self.navigator.gpu.requestAdapter().catch(() => null))) {
        try {
          asr = await pipeline("automatic-speech-recognition", model, { device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } });
          self.postMessage({ status: "ready", quality, device: "gpu" });
        } catch { asr = null; }
      }
      if (!asr) {
        asr = await pipeline("automatic-speech-recognition", model, { dtype: "q8", device: "wasm" });
        self.postMessage({ status: "ready", quality, device: "cpu" });
      }
      loaded = model;
    }
    const started = performance.now();
    const out = await asr(audio);
    self.postMessage({ id, text: (out.text || "").trim(), ms: Math.round(performance.now() - started) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
