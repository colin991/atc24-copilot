// Built-in speech to text, used when the fast online one isn't available.
// Runs Whisper (base, English) on this PC in a background thread. The model
// (~80 MB) downloads once from Hugging Face the first time it's needed.
import { pipeline, env } from "../node_modules/@huggingface/transformers/dist/transformers.min.js";

env.allowLocalModels = false;
let asr = null;

self.onmessage = async (e) => {
  const { id, audio } = e.data;
  try {
    if (!asr) {
      self.postMessage({ status: "loading" });
      asr = await pipeline("automatic-speech-recognition", "onnx-community/whisper-base.en", { dtype: "q8", device: "wasm" });
      self.postMessage({ status: "ready" });
    }
    const started = performance.now();
    const out = await asr(audio, { language: undefined });
    self.postMessage({ id, text: (out.text || "").trim(), ms: Math.round(performance.now() - started) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
