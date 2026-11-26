# ATC 24 Copilot

A small Windows overlay for **ATC 24** (Roblox). When ATC talks to you it shows
**what to do** and **what to say back**, using your live flight from the
[ATC24 Radar](https://atc24-radar-mauve.vercel.app).

**Download:** https://atc24-radar-mauve.vercel.app/download

```
DO   1. Turn LEFT to heading 270 (now 310).
     2. Climb to 5,000 ft (now 2100 ft).
SAY  Left heading 270, climb and maintain 5000, Speedbird 208
```

## How it works

1. **Hears the call.** It listens to system audio (game + Discord) or a mic you
   pick, and cuts out each radio call with a simple voice detector
   (`renderer/audio.js`).
2. **Speech to text.** Fast path: Groq's hosted Whisper through the radar's
   `/api/stt` (the key stays on Vercel, never in the app). If that's not
   available it runs Whisper on your PC (`renderer/whisper-worker.js`; ~80 MB
   model downloaded once).
3. **Understands it.** `src/atc.js` reads standard phraseology with rules:
   instant, no model. On generated test calls it gets ~93% fully right and
   "is it for me" 100% (`node model/score-rules.mjs`).
4. **Model for the rest** (`model/`): a fine-tuned Qwen2.5-0.5B, trained the
   same way as the Clearwater dispatch model (template calls → LoRA → GGUF),
   for wording the rules don't know. It only outputs short JSON; the app writes
   the "do" and "say" text, so answers stay fast.

## Keys

| Keys | Does |
| --- | --- |
| Ctrl+Shift+X | click through the overlay to the game (and back) |
| Ctrl+Shift+H | hide / show |
| Ctrl+Shift+P | pause / resume listening |

## Develop

```
npm install
npm test          # parser tests
npm start         # run the overlay
npm run dist      # build dist/ATC24-Copilot-Setup.exe
```

Every push to `main` builds the installer on GitHub Actions and publishes a
release; installed copies update themselves.

Train the model (NVIDIA card, 8 GB+): `model\train.bat` (needs Python with
`torch transformers peft accelerate`, and llama.cpp for `convert.py`).

Unofficial fan tool, not affiliated with ATC 24 or Roblox. Audio is turned into
text and dropped; nothing is recorded. GPL-3.0-or-later.
