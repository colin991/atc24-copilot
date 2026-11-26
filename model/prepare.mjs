// Turns generated calls into chat examples for training.
//   node model/prepare.mjs model/data/synth.jsonl [model/data/real.jsonl] > model/data/train.jsonl
//
// The model only has to say what the call MEANS, as short JSON; the app
// writes the "do" and "say" text itself. Short answers = fast answers.
// real.jsonl (optional) = corrected real calls, repeated 3x so they count more.
import fs from "node:fs";

export const SYSTEM = "You read ATC radio calls for the pilot named after Me. Reply with JSON only: {\"me\":true|false,\"i\":[instructions]}.";
export const userText = (me, call) => `Me: ${me}\nCall: ${call}`;

const [synthPath, realPath] = process.argv.slice(2);
const read = (p) => (p && fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const rows = [...read(synthPath), ...read(realPath).flatMap((r) => [r, r, r])];
for (const r of rows) {
  process.stdout.write(JSON.stringify({ messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: userText(r.me, r.call) },
    { role: "assistant", content: JSON.stringify(r.out) },
  ] }) + "\n");
}
