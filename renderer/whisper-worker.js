// Built-in speech to text, used when the fast online one isn't available.
// Runs Whisper (English) on this PC in a background thread. Models download
// once from Hugging Face the first time they're needed:
//
//   auto     = pick for this PC: graphics card -> accurate, else a CPU size
//   accurate = whisper-small.en (best with numbers; ~590 MB on a graphics card)
//   fast     = whisper-base.en  (~80 MB)
//   light    = whisper-tiny.en  (~40 MB, for low-end PCs)
//
// A big model can take minutes to download, so the light one starts first
// (ready in seconds) and the chosen one takes over once it's downloaded.
import { pipeline, env } from "../node_modules/@huggingface/transformers/dist/transformers.min.js";

env.allowLocalModels = false;
// Use several CPU cores when the app allows it (faster on every PC).
try { env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(4, (self.navigator?.hardwareConcurrency || 2) - 1)); } catch {}

const MODELS = { accurate: "onnx-community/whisper-small.en", fast: "onnx-community/whisper-base.en", light: "onnx-community/whisper-tiny.en" };
let asr = null;          // the model in use right now
let using = null;        // its size
let target = null;       // the size we want
let loading = null;      // the target's download, while it runs
let gpuOk = null;

async function hasGpu() {
  if (gpuOk !== null) return gpuOk;
  try { gpuOk = !!(self.navigator?.gpu && (await self.navigator.gpu.requestAdapter())); } catch { gpuOk = false; }
  return gpuOk;
}

// What "auto" means on this PC.
async function pick(quality, noGpu) {
  const gpu = noGpu ? false : await hasGpu();
  if (quality !== "auto") return { size: quality, gpu };
  if (gpu) return { size: "accurate", gpu };
  const cores = self.navigator?.hardwareConcurrency || 2;
  return { size: cores >= 6 ? "fast" : "light", gpu };
}

// Load one model, reporting download progress (in MB, since the total grows
// as each file is found).
async function load(size, gpu, report) {
  const files = new Map();
  const progress_callback = (p) => {
    if (!report || p.status !== "progress" || !p.file) return;
    files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
    let l = 0, t = 0;
    for (const f of files.values()) { l += f.loaded; t += f.total; }
    if (t > 0) self.postMessage({ status: "download", size, mb: Math.round(l / 1e6), totalMb: Math.round(t / 1e6) });
  };
  const model = MODELS[size] || MODELS.fast;
  if (gpu) {
    try {
      const p = await pipeline("automatic-speech-recognition", model, { device: "webgpu", dtype: { encoder_model: "fp32", decoder_model_merged: "q4" }, progress_callback });
      return { p, device: "gpu" };
    } catch {}
  }
  const p = await pipeline("automatic-speech-recognition", model, { dtype: "q8", device: "wasm", progress_callback });
  return { p, device: "cpu" };
}

async function ensure(quality, noGpu) {
  const { size, gpu } = await pick(quality, noGpu);
  if (target === size && (asr || loading)) return;
  target = size;
  // Something to answer with straight away: the light model (small, quick).
  if (!asr && size !== "light") {
    self.postMessage({ status: "loading", quality: "light" });
    const { p, device } = await load("light", false, true);
    asr = p; using = "light";
    self.postMessage({ status: "ready", quality: "light", device, interim: true, next: size });
  }
  // Then the one we actually want, in the background.
  loading = load(size, gpu, true).then(async ({ p, device }) => {
    if (target !== size) return;
    const old = asr;
    asr = p; using = size; loading = null;
    // Free the old model only once any call it is working on has finished.
    if (old && old !== p) setTimeout(() => { try { old.dispose?.(); } catch {} }, 30000);
    self.postMessage({ status: "ready", quality: size, device });
  }).catch((err) => { loading = null; self.postMessage({ status: "failed", error: String(err?.message || err) }); });
  if (!asr) await loading; // nothing to answer with yet (light was the target)
}

self.onmessage = async (e) => {
  const { id, audio, quality = "auto", noGpu = false } = e.data;
  try {
    await ensure(quality, noGpu);
    const started = performance.now();
    const out = await asr(audio);
    self.postMessage({ id, text: (out.text || "").trim(), ms: Math.round(performance.now() - started), model: using });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
