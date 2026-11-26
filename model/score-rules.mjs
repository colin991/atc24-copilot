// How well does the fast rule path (src/atc.js) do on generated calls?
//   node model/synth.mjs 3000 99 > model/data/eval.jsonl
//   node model/score-rules.mjs model/data/eval.jsonl [show=10]
// Prints accuracy per instruction type and some misses to fix.
import fs from "node:fs";
import { understand } from "../src/atc.js";

const [file, showArg] = process.argv.slice(2);
const show = +(showArg || 10);
const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// Compare the parts that change what you do: type + the main value.
const key = (i) => {
  switch (i.t || i.type) {
    case "heading": return `heading ${i.hdg ?? i.heading}`;
    case "altitude": return `altitude ${i.ft}`;
    case "speed": return `speed ${i.kt}`;
    case "squawk": return `squawk ${i.code}`;
    case "contact": return `contact ${i.freq}`;
    case "takeoff": case "land": case "lineup": case "holdshort": return `${i.t || i.type} ${i.rwy ?? i.runway}`;
    case "taxi": return `taxi ${i.rwy ?? i.runway} ${(i.via ?? i.route ?? []).join("")}`;
    case "approach": return `approach ${i.rwy ?? i.runway}`;
    case "direct": return `direct ${i.fix}`;
    case "clearance": return `clearance ${i.dest}`;
    default: return i.t || i.type;
  }
};

let ok = 0, meOk = 0;
const byType = {}, misses = [];
for (const ex of lines) {
  const r = understand(ex.call, { callsign: ex.me });
  const want = ex.out.i.map(key), got = r.items.filter((i) => i.type !== "report" && i.type !== "expect").map(key);
  const good = want.length === got.length && want.every((w, k) => w === got[k]);
  const meGood = ex.out.me ? r.forMe === true : r.forMe !== true;
  if (good) ok++;
  if (meGood) meOk++;
  for (const i of ex.out.i) { const t = i.t; byType[t] ||= [0, 0]; byType[t][1]++; if (got.includes(key(i))) byType[t][0]++; }
  if (!good && misses.length < show) misses.push({ call: ex.call, want, got });
}
console.log(`Calls fully right: ${ok}/${lines.length} (${((100 * ok) / lines.length).toFixed(1)}%)`);
console.log(`"Is it for me" right: ${meOk}/${lines.length} (${((100 * meOk) / lines.length).toFixed(1)}%)`);
for (const [t, [a, n]] of Object.entries(byType).sort((x, y) => x[1][0] / x[1][1] - y[1][0] / y[1][1])) console.log(`  ${t.padEnd(10)} ${((100 * a) / n).toFixed(0).padStart(3)}%  (${n})`);
if (misses.length) { console.log("\nSome misses:"); for (const m of misses) console.log(`- ${m.call}\n    want ${JSON.stringify(m.want)}\n    got  ${JSON.stringify(m.got)}`); }
