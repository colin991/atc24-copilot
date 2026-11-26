"""Turns model/out/merged into a small .gguf the app can run on any PC
(same steps as the Clearwater trainer: llama.cpp convert, then quantize).

    python model/convert.py            # -> model/out/atc-model.Q4_K_M.gguf (~400 MB)

Needs llama.cpp next to this repo (git clone https://github.com/ggml-org/llama.cpp,
pip install -r llama.cpp/requirements.txt) and its llama-quantize tool built or
downloaded from a llama.cpp release (set LLAMA_QUANTIZE to its path).
"""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
LLAMA = os.environ.get("LLAMA_CPP", os.path.join(HERE, "..", "..", "llama.cpp"))
QUANT = os.environ.get("LLAMA_QUANTIZE", "llama-quantize")
merged = os.path.join(HERE, "out", "merged")
f16 = os.path.join(HERE, "out", "atc-model.f16.gguf")
final = os.path.join(HERE, "out", f"atc-model.{os.environ.get('QUANT', 'Q4_K_M')}.gguf")

if not os.path.isdir(merged):
    sys.exit("No model/out/merged yet: run model/train.py first.")
subprocess.run([sys.executable, os.path.join(LLAMA, "convert_hf_to_gguf.py"), merged, "--outfile", f16, "--outtype", "f16"], check=True)
subprocess.run([QUANT, f16, final, os.environ.get("QUANT", "Q4_K_M")], check=True)
os.remove(f16)
print(f"Done: {final} ({os.path.getsize(final) / 1e6:.0f} MB)")
