// Built-in speech to text, used when the fast online one isn't available.
// Runs Whisper (English) on this PC in a background thread. The model
// downloads once from Hugging Face the first time it's needed.
//
//   auto     = pick for this PC: graphics card -> accurate, else a CPU size
//   accurate = whisper-small.en (~250 MB, best with numbers; wants a graphics card)
//   fast     = whisper-base.en  (~80 MB)
//   light    = whisper-tiny.en  (~40 MB, for low-end PCs)
import { pipeline, env } from "../node_modules/@huggingface/transformers/dist/transformers.min.js";

env.allowLocalModels = false;
// Use several CPU cores when the app allows it (faster on every PC).
try { env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, (self.navigator?.hardwareConcurrency || 2) - 1)); } catch {}

const MODELS = { accurate: "onnx-community/whisper-small.en", fast: "onnx-community/whisper-base.en", light: "onnx-community/whisper-tiny.en" };
let asr = null, loaded = null, gpuOk = null;

async function hasGpu() {
  if (gpuOk !== null) return gpuOk;
  try { gpuOk = !!(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter())); } catch { gpuOk = false; }
  return gpuOk;
}

// What "auto" means on this PC.
async function pick(quality) {
  const gpu = await hasGpu();
  if (quality !== "auto") return { size: quality, gpu };
  if (gpu) return { size: "accurate", gpu };
  const cores = self.navigator?.hardwareConcurrency || 2;
  return { size: cores >= 6 ? "fast" : "light", gpu };
}

self.onmessage = async (e) => {
  const { id, audio, quality = "auto" } = e.data;
  try {
    const { size, gpu } = await pick(quality);
    const model = MODELS[size] || MODELS.fast;
    if (!asr || loaded !== model) {
      self.postMessage({ status: "loading", quality: size });
      asr = null;
      // The graphics card is much faster; fall back to the CPU if it fails.
      if (gpu) {
        try {
          asr = await pipeline("automatic-speech-recognition", model, { device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } });
          self.postMessage({ status: "ready", quality: size, device: "gpu" });
        } catch { asr = null; }
      }
      if (!asr) {
        asr = await pipeline("automatic-speech-recognition", model, { dtype: "q8", device: "wasm" });
        self.postMessage({ status: "ready", quality: size, device: "cpu" });
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
