"""Fine-tunes a small model to read ATC calls (LoRA, like the Clearwater
dispatch trainer, but on Qwen2.5-0.5B so it answers ~3x faster on CPU).

    python model/train.py                 # full run (~15-20 min on an 8 GB NVIDIA card)
    python model/train.py --quick         # continue from the last model, fewer steps

Needs: pip install torch transformers peft accelerate
Output: model/out/merged  (then run model/convert.py to make the .gguf)
"""
import argparse, json, math, os, random, time

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "Qwen/Qwen2.5-0.5B-Instruct"

ap = argparse.ArgumentParser()
ap.add_argument("--data", default=os.path.join(HERE, "data", "train.jsonl"))
ap.add_argument("--out", default=os.path.join(HERE, "out"))
ap.add_argument("--epochs", type=float, default=2)
ap.add_argument("--lr", type=float, default=2e-4)
ap.add_argument("--batch", type=int, default=16)
ap.add_argument("--quick", action="store_true", help="continue from out/merged at a lower learning rate")
args = ap.parse_args()

start_from = os.path.join(args.out, "merged") if args.quick and os.path.isdir(os.path.join(args.out, "merged")) else BASE
lr = 1e-4 if args.quick else args.lr
epochs = 1 if args.quick else args.epochs
device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.bfloat16 if device == "cuda" and torch.cuda.is_bf16_supported() else torch.float32
print(f"Training from {start_from} on {device} ({dtype}), lr {lr}, {epochs} epochs")

tok = AutoTokenizer.from_pretrained(start_from)
model = AutoModelForCausalLM.from_pretrained(start_from, torch_dtype=dtype).to(device)
model.gradient_checkpointing_enable()
model.enable_input_require_grads()
model = get_peft_model(model, LoraConfig(
    r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
))
model.print_trainable_parameters()

# Tokenise; only the answer (assistant turn) counts towards the loss.
rows = [json.loads(l) for l in open(args.data, encoding="utf8") if l.strip()]
examples = []
for r in rows:
    msgs = r["messages"]
    prompt = tok.apply_chat_template(msgs[:-1], tokenize=False, add_generation_prompt=True)
    answer = msgs[-1]["content"] + tok.eos_token
    p_ids = tok(prompt, add_special_tokens=False)["input_ids"]
    a_ids = tok(answer, add_special_tokens=False)["input_ids"]
    ids = (p_ids + a_ids)[:384]
    labels = ([-100] * len(p_ids) + a_ids)[:384]
    examples.append((ids, labels))
print(f"{len(examples)} examples")

def batches():
    random.shuffle(examples)
    for i in range(0, len(examples), args.batch):
        chunk = examples[i:i + args.batch]
        n = max(len(x[0]) for x in chunk)
        ids = torch.full((len(chunk), n), tok.pad_token_id or 0)
        lab = torch.full((len(chunk), n), -100)
        att = torch.zeros((len(chunk), n), dtype=torch.long)
        for j, (x, y) in enumerate(chunk):
            ids[j, :len(x)] = torch.tensor(x); lab[j, :len(y)] = torch.tensor(y); att[j, :len(x)] = 1
        yield ids.to(device), lab.to(device), att.to(device)

steps = math.ceil(len(examples) / args.batch) * epochs
opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=lr, weight_decay=0.0)
sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / 30) * max(0.05, 1 - s / steps))
model.train()
step, t0 = 0, time.time()
while step < steps:
    for ids, lab, att in batches():
        loss = model(input_ids=ids, attention_mask=att, labels=lab).loss
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step(); sched.step(); opt.zero_grad()
        step += 1
        if step % 20 == 0 or step == 1:
            print(f"step {step}/{steps}  loss {loss.item():.4f}  {time.time() - t0:.0f}s")
        if step >= steps:
            break

print("Merging the LoRA into the model...")
merged = model.merge_and_unload()
os.makedirs(os.path.join(args.out, "merged"), exist_ok=True)
merged.save_pretrained(os.path.join(args.out, "merged"), safe_serialization=True)
tok.save_pretrained(os.path.join(args.out, "merged"))
print(f"Saved {os.path.join(args.out, 'merged')}. Next: python model/convert.py")
