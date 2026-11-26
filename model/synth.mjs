// Makes training examples for the ATC model: radio calls (written the way
// speech-to-text writes them, with spoken numbers, filler and sloppy
// phrasing) paired with what they mean, as compact JSON.
//
//   node model/synth.mjs [count=6000] [seed=7] > model/data/synth.jsonl
//
// Each line: {"call": "...", "me": "Speedbird-208", "out": {"me":true,"i":[...]}}
// Same idea as the Clearwater dispatch trainer: weighted hand-written
// templates and a seeded random generator, no LLM needed.
const COUNT = +(process.argv[2] || 6000);
let seed = +(process.argv[3] || 7);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));

const AIRLINES = ["Speedbird", "Shamrock", "Lufthansa", "Delta", "United", "Emirates", "Qatar", "Ryanair", "Jetbloo", "Oldzealand", "Warlock", "Supertransport", "Reunited", "Worldstar", "Cessna", "Air Volta", "Bayview", "Sky Orenji"];
const FACILITIES = ["Ground", "Tower", "Approach", "Departure", "Center", "Director", "Delivery"];
const PLACES = ["Rockford", "Perth", "Tokyo", "Larnaca", "Izolirani", "Paphos", "Mellor", "Sauthemptona", "Grindavik", "Saint Barthelemy", "Lukla", "Orenji"];
const AIRPORTS = ["IRFD", "IPPH", "ITKO", "ILAR", "IZOL", "IPAP", "IMLR", "ISAU", "IGRV", "IBTH", "ILKL", "IMLR", "ISCM"];
const FIXES = ["GRASS", "LAZER", "JACKI", "AQWRT", "BUCFA", "DINER", "KNIFE", "SHELL", "WELSH", "ROCKY", "HONDA", "NOONU"];
const PHON = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "juliet", "kilo", "lima", "mike"];
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner"];
const FILLER = ["uh", "um", "uhh", "er"];

// Numbers the way people say them on the radio (and Whisper writes them).
const spellDigits = (n, w = 0) => String(n).padStart(w, "0").split("").map((d) => (chance(0.15) && d === "9" ? "nine" : WORDS[+d])).join(" ");
const sayNum = (n, w = 0) => (chance(0.55) ? String(n).padStart(w, "0") : spellDigits(n, w));
function sayAltitude(ft) {
  if (ft >= 18000) { const fl = ft / 100; return pick([`flight level ${sayNum(fl, 3)}`, `FL${fl}`, `flight level ${fl}`]); }
  const th = Math.floor(ft / 1000), hu = (ft % 1000) / 100;
  if (chance(0.45)) return chance(0.5) ? `${ft}` : `${ft.toLocaleString("en-US")}`;
  return `${chance(0.6) ? WORDS[th] ?? th : th} thousand${hu ? ` ${WORDS[hu]} hundred` : ""}`;
}
const sayRunway = (n, side) => `${chance(0.5) ? String(n).padStart(2, "0") : spellDigits(n, 2)}${side ? ` ${pick({ L: ["left"], R: ["right"], C: ["center"] }[side])}` : ""}`;
function sayFreq(f) {
  const [a, b] = f.split(".");
  return chance(0.5) ? f : `${spellDigits(+a)} ${pick(["decimal", "point"])} ${b.split("").map((d) => WORDS[+d]).join(" ")}`;
}
const callsign = () => { const a = pick(AIRLINES); const n = int(1, 9999); return { cs: `${a}-${n}`, said: `${a} ${chance(0.5) ? n : spellDigits(n)}` }; };

// ---- instruction makers: [spoken text, meaning] --------------------------------
const MAKERS = [
  [10, () => { const h = int(1, 36) * 10; const d = pick(["left", "right", null]);
    return [pick(d ? [`turn ${d} heading ${sayNum(h, 3)}`, `${d} turn heading ${sayNum(h, 3)}`, `turn ${d} ${sayNum(h, 3)}`, `${d} heading ${sayNum(h, 3)}`] : [`fly heading ${sayNum(h, 3)}`, `heading ${sayNum(h, 3)}`, `continue heading ${sayNum(h, 3)}`, `make it heading ${sayNum(h, 3)}`]),
      { t: "heading", hdg: h, dir: d }]; }],
  [10, () => { const ft = chance(0.25) ? int(18, 39) * 1000 : int(2, 16) * 1000 + (chance(0.3) ? 500 : 0); const v = pick(["climb", "descend"]);
    return [pick([`${v} and maintain ${sayAltitude(ft)}`, `${v} to ${sayAltitude(ft)}`, `${v} ${sayAltitude(ft)}`, `${v} and maintain ${sayAltitude(ft)} feet`, `go ${v === "climb" ? "up" : "down"} to ${sayAltitude(ft)}`]), { t: "altitude", ft, v }]; }],
  [4, () => { const ft = int(2, 12) * 1000; return [pick([`maintain ${sayAltitude(ft)}`, `stay at ${sayAltitude(ft)}`]), { t: "altitude", ft, v: "maintain" }]; }],
  [6, () => { const kt = int(14, 28) * 10; const v = pick(["reduce", "increase", "maintain", null]);
    return [pick([`${v ? v + " " : ""}speed ${sayNum(kt)}${chance(0.5) ? " knots" : ""}`, `${v || "reduce"} to ${sayNum(kt)} knots`, `slow to ${sayNum(kt)} knots`]), { t: "speed", kt }]; }],
  [6, () => { const c = [0, 0, 0, 0].map(() => int(0, 7)).join(""); return [pick([`squawk ${sayNum(c)}`, `squawk ${spellDigits(c)}`, `reset squawk ${sayNum(c)}`]), { t: "squawk", code: c }]; }],
  [7, () => { const f = `1${int(18, 35)}.${pick(["0", "05", "1", "15", "2", "25", "3", "35", "4", "45", "5", "55", "6", "65", "7", "75", "8", "85", "9", "95"])}`; const fac = `${pick(PLACES)} ${pick(FACILITIES)}`;
    return [pick([`contact ${fac} ${sayFreq(f)}`, `contact ${fac} on ${sayFreq(f)}`, `monitor ${fac} ${sayFreq(f)}`, `switch to ${fac} ${sayFreq(f)}`, `call ${fac} on ${sayFreq(f)}`]), { t: "contact", freq: f, fac }]; }],
  [6, () => { const r = int(1, 36), s = pick(["L", "R", null, null]); const rw = `${String(r).padStart(2, "0")}${s || ""}`;
    return [pick([`runway ${sayRunway(r, s)} cleared for takeoff`, `cleared for takeoff runway ${sayRunway(r, s)}`, `runway ${sayRunway(r, s)}, wind ${int(1, 36)}0 at ${int(2, 15)}, cleared for takeoff`]), { t: "takeoff", rwy: rw }]; }],
  [6, () => { const r = int(1, 36), s = pick(["L", "R", null, null]); const rw = `${String(r).padStart(2, "0")}${s || ""}`;
    return [pick([`runway ${sayRunway(r, s)} cleared to land`, `cleared to land runway ${sayRunway(r, s)}`, `wind calm, runway ${sayRunway(r, s)}, cleared to land`]), { t: "land", rwy: rw }]; }],
  [4, () => { const r = int(1, 36); const rw = String(r).padStart(2, "0"); return [pick([`line up and wait runway ${sayRunway(r)}`, `runway ${sayRunway(r)} line up and wait`]), { t: "lineup", rwy: rw }]; }],
  [5, () => { const r = int(1, 36), s = pick(["L", "R", null]); const rw = `${String(r).padStart(2, "0")}${s || ""}`; const via = [pick(PHON), ...(chance(0.6) ? [`${pick(PHON)} ${int(1, 6)}`] : [])];
    const letters = via.map((v) => v.replace(/^(\w)\w*/, (m) => m[0].toUpperCase()).replace(" ", ""));
    const hs = chance(0.4);
    return [`taxi to ${chance(0.3) ? "holding point " : ""}runway ${sayRunway(r, s)} via ${via.join(", ")}${hs ? `, hold short runway ${sayRunway(r, s)}` : ""}`, [{ t: "taxi", rwy: rw, via: letters }, ...(hs ? [{ t: "holdshort", rwy: rw }] : [])]]; }],
  [3, () => { const r = int(1, 36); const rw = String(r).padStart(2, "0"); return [pick([`hold short runway ${sayRunway(r)}`, `hold short of runway ${sayRunway(r)}`]), { t: "holdshort", rwy: rw }]; }],
  [3, () => [pick(["pushback approved", "push and start approved", "push back approved, face east"]), { t: "pushback" }]],
  [3, () => { const r = int(1, 36), s = pick(["L", "R", null]); const k = pick(["ILS", "RNAV", "visual"]); const rw = `${String(r).padStart(2, "0")}${s || ""}`;
    return [pick([`cleared ${k} approach runway ${sayRunway(r, s)}`, `cleared for the ${k} runway ${sayRunway(r, s)}`, `cleared ${k} runway ${sayRunway(r, s)} approach`]), { t: "approach", kind: k.toUpperCase(), rwy: rw }]; }],
  [3, () => { const f = pick(FIXES); return [pick([`proceed direct ${f}`, `direct ${f}`, `fly direct to ${f}`, `cleared direct ${f}`]), { t: "direct", fix: f }]; }],
  [2, () => [pick(["go around", "go around, I say again go around", "go around, climb runway heading"]), { t: "goaround" }]],
  [2, () => [pick(["radar contact", "identified", "radar contact, climb via the SID"]), { t: "info" }]],
  [2, () => [pick(["say altitude", "say your altitude", "confirm altitude"]), { t: "sayalt" }]],
  [2, () => [pick(["frequency change approved", "frequency change approved, good day"]), { t: "freqchange" }]],
  [2, () => [pick(["resume own navigation", "resume own nav"]), { t: "ownnav" }]],
  [2, () => [pick(["hold position", "hold your position", "stop immediately, hold position"]), { t: "holdpos" }]],
  [3, () => { const dest = pick(AIRPORTS), r = int(1, 36), ft = int(2, 6) * 1000, c = [0, 0, 0, 0].map(() => int(0, 7)).join(""), sid = `${pick(FIXES)}${int(1, 3)}${pick(["A", "B", "C"])}`;
    return [`cleared to ${chance(0.5) ? dest : dest.split("").join(" ")} via the ${sid} departure, runway ${sayRunway(r)}, initial climb ${sayAltitude(ft)}, squawk ${sayNum(c)}`, { t: "clearance", dest, sid, rwy: String(r).padStart(2, "0"), ft, code: c }]; }],
];
const totalW = MAKERS.reduce((s, m) => s + m[0], 0);
const make = () => { let r = rnd() * totalW; for (const [w, f] of MAKERS) { if ((r -= w) < 0) return f(); } return MAKERS[0][1](); };

// ---- whole calls -------------------------------------------------------------------
function call() {
  const meCs = callsign(), other = callsign();
  const toMe = chance(0.8);
  const who = toMe ? meCs : other;
  const n = pick([1, 1, 1, 2, 2, 3]);
  const parts = [], items = [];
  for (let i = 0; i < n; i++) {
    const [text, meaning] = make();
    if (meaning.t === "clearance" && n > 1) continue; // a clearance is a whole call on its own
    parts.push(text); items.push(...(Array.isArray(meaning) ? meaning : [meaning]));
  }
  let body = parts.join(pick([", ", ", ", " then ", " and ", ". "]));
  if (chance(0.12)) body = `${pick(FILLER)} ${body}`;
  const end = chance(0.15) ? pick([", good day", ", thanks", ""]) : "";
  const first = chance(0.85);
  let text = first ? `${who.said}, ${body}${end}` : `${body}, ${who.said}${end}`;
  if (chance(0.1)) text = text.replace(/,/g, "");           // no punctuation
  if (chance(0.3)) text = text.toLowerCase();
  if (chance(0.4)) text = text.charAt(0).toUpperCase() + text.slice(1) + ".";
  return { call: text, me: meCs.cs, out: { me: toMe, i: items } };
}

for (let i = 0; i < COUNT; i++) process.stdout.write(JSON.stringify(call()) + "\n");
