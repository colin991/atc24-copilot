// A real speech detector (Silero VAD, ~2 MB): tells human voices apart from
// engine noise, wind and music, which loudness alone can't do in flight.
//   const vad = await loadVad();  vad(frame512) -> probability 0..1 that it's speech
import { AutoModel, Tensor, env } from "../node_modules/@huggingface/transformers/dist/transformers.min.js";

env.allowLocalModels = false;

export async function loadVad() {
  const model = await AutoModel.from_pretrained("onnx-community/silero-vad", { config: { model_type: "custom" }, dtype: "fp32" });
  let state = new Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
  const sr = new Tensor("int64", [16000n], []);
  return async (frame) => {
    const out = await model({ input: new Tensor("float32", frame, [1, frame.length]), sr, state });
    state = out.stateN;
    return out.output.data[0];
  };
}
