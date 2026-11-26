// The fast path: understands standard ATC instructions with rules, no model.
//
//   understand(transcript, { callsign, flight }) -> {
//     forMe,           true / false / null (no callsign heard)
//     items: [{ type, do, say, ...values }],   one per instruction, in order
//     readback,        what to say back, e.g. "Left heading 270, climb 5000, Speedbird 208"
//     heard,           the cleaned-up transcript
//     unknown,         true when nothing was recognised (the model gets a go)
//   }
//
// `flight` (optional) is your aircraft from the radar: { heading, altitude,
// groundSpeed, isOnGround }, used to say which way to turn, how far to climb.
import { normalize, PHONETIC } from "./words.js";

const AIRLINE_WORDS = new Set(["speedbird", "shamrock", "lufthansa", "delta", "united", "american", "emirates", "qatar", "ryanair", "easy", "easyjet", "jetbloo", "jetblue", "oldzealand", "warlock", "supertransport", "reunited", "worldstar", "cessna", "november"]);

// --- callsigns -----------------------------------------------------------
// "Speedbird-208" -> { name: "speedbird", num: "208" }
export function splitCallsign(cs) {
  const s = String(cs || "").toLowerCase().replace(/[-_]/g, " ");
  const num = (s.match(/\d+/g) || []).join("");
  const name = s.replace(/\d+/g, " ").trim().split(/\s+/)[0] || "";
  return { name, num };
}

// Readback style: "Speedbird 208"
export function spokenCallsign(cs) {
  const { name, num } = splitCallsign(cs);
  if (!name && !num) return "";
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${num}`.trim();
}

function addressee(text, me) {
  // Callsign is normally first: "speedbird 208 , turn left ..."
  const head = text.split(" , ")[0].split(" ").slice(0, 4).join(" ");
  const nums = head.match(/\b\d{2,5}\b/g) || [];
  if (!me.num) return { forMe: null, said: null };
  if (nums.includes(me.num)) return { forMe: true, said: head };
  // Anywhere else (e.g. "turn left heading 270 speedbird 208")
  if (new RegExp(`\\b${me.name}\\s*${me.num}\\b`).test(text) || new RegExp(`\\b${me.num}\\b`).test(text.split(" , ").pop())) return { forMe: true, said: null };
  // Someone else's callsign up front: a word we know as an airline + a number
  const first = head.split(" ");
  if (nums.length && (AIRLINE_WORDS.has(first[0]) || /^[a-z]+$/.test(first[0])) && /^\d{2,5}$/.test(first[1] || "")) return { forMe: false, said: head };
  return { forMe: null, said: null };
}

// --- helpers ---------------------------------------------------------------
const pad3 = (h) => String(((h % 360) + 360) % 360 || 360).padStart(3, "0");
const fmtAlt = (ft) => ft >= 18000 && ft % 100 === 0 ? `FL${String(ft / 100).padStart(3, "0")}` : `${ft.toLocaleString("en-US")} ft`;
const sayAlt = (a) => (a.fl ? `flight level ${a.fl}` : `${a.ft}`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// "alpha , bravo 2" -> ["A", "B2"]
const letters = (s) => {
  const t = s.split(/[\s,]+/).filter(Boolean), out = [];
  for (let i = 0; i < t.length; i++) {
    let w = PHONETIC[t[i]] || (/^[a-z]\d{0,2}$/.test(t[i]) ? t[i].toUpperCase() : null);
    if (!w) continue;
    if (/^[A-Z]$/.test(w) && /^\d{1,2}$/.test(t[i + 1] || "")) { w += t[i + 1]; i++; }
    out.push(w);
  }
  return out;
};
const TWY_WORD = new RegExp(`^(?:(?:${Object.keys(PHONETIC).join("|")})(?: [0-9]{1,2})?|[a-z][0-9]{0,2})$`);

function parseAlt(s) {
  let m = /\bfl(\d{2,3})\b/.exec(s);
  if (m) return { fl: m[1], ft: +m[1] * 100 };
  m = /\b(\d{3,5})\b\s*(?:feet|ft)?/.exec(s);
  if (m && +m[1] >= 500 && +m[1] <= 45000 && +m[1] % 100 === 0) return { ft: +m[1] };
  return null;
}
const parseRunway = (s) => { const m = /\brunway\s+(\d{2}[LRC]?)/i.exec(s); return m ? m[1].toUpperCase() : null; };
// The runway in this clause, or else the last one said before it
// ("runway 15, wind 100 at 12, cleared for takeoff").
function runwayFor(c, all) {
  const own = parseRunway(c);
  if (own) return own;
  const before = all.slice(0, Math.max(0, all.indexOf(c)));
  const list = [...before.matchAll(/\brunway\s+(\d{2}[LRC]?)/gi)];
  return list.length ? list[list.length - 1][1].toUpperCase() : null;
}
const parseFreq = (s) => { const m = /\b(1[1-3]\d\.\d{1,3})\b/.exec(s); return m ? m[1] : null; };
const FACILITY = /\b(delivery|clearance|ground|tower|approach|departure|director|center|centre|control|radar|information|unicom)\b/;

function turnDir(from, to) {
  if (from == null) return null;
  const d = (((to - from) % 360) + 540) % 360 - 180;
  return d < 0 ? "left" : "right";
}

// --- instruction rules -------------------------------------------------------
// Each rule looks at one clause and returns items (or null). Order matters:
// more specific phrases first.
const RULES = [
  // IFR clearance: "cleared to IRFD via ..., runway 25, initial climb 3000, squawk 4521"
  (c, all, ctx) => {
    // An airport spelled out letter by letter: "cleared to i l k l"
    const spelled = /\bcleared to ([a-z]) ([a-z]) ([a-z]) ([a-z])\b/.exec(c);
    if (spelled) { const joined = `cleared to ${spelled.slice(1).join("")}`; c = c.replace(spelled[0], joined); all = all.replace(spelled[0], joined); }
    const m = /\bcleared to\s+([a-z]{4}|[a-z]+(?: [a-z]+)?)\b(?!.*\b(land|takeoff|take off)\b)/.exec(c);
    if (!m || /\bcleared to (land|cross|enter|push)\b/.test(c)) return null;
    const dest = m[1].length === 4 ? m[1].toUpperCase() : cap(m[1]);
    const via = /\bvia\s+(.+?)(?=$| , |\bdeparture\b|\brunway\b|\binitial|\bclimb|\bsquawk)/.exec(all);
    const dep = /\b([a-z]+ ?\d[a-z]?)\s+departure\b/.exec(all);
    const rwy = parseRunway(all);
    const init = /\b(?:initial(?:ly)? (?:climb|altitude)|climb (?:and maintain|to)?)\s+(fl\d{2,3}|\d{3,5})/.exec(all);
    const sq = /\bsquawk\s+([0-7]{4})\b/.exec(all);
    const parts = [`cleared to ${dest}`];
    if (dep) parts.push(`${dep[1].toUpperCase()} departure`);
    if (via) parts.push(`via ${via[1].trim()}`);
    if (rwy) parts.push(`runway ${rwy}`);
    if (init) parts.push(`climb ${init[1].startsWith("fl") ? init[1].toUpperCase() : init[1]}`);
    if (sq) parts.push(`squawk ${sq[1]}`);
    ctx.consumedAll = true; // the whole call is one clearance
    return [{ type: "clearance", dest, runway: rwy, squawk: sq?.[1], do: `IFR clearance to ${dest}${rwy ? `, departing runway ${rwy}` : ""}${init ? `, first climb to ${init[1].startsWith("fl") ? init[1].toUpperCase() : init[1] + " ft"}` : ""}${sq ? `. Set squawk ${sq[1]}` : ""}.`, say: parts.join(", ") }];
  },
  // Takeoff / landing / line up
  (c, all) => {
    if (!/\bcleared (?:for )?(?:take ?off|takeoff)\b/.test(c)) return null;
    const rwy = runwayFor(c, all); // "runway 15, wind 100 at 12, cleared for takeoff"
    return [{ type: "takeoff", runway: rwy, do: `Take off${rwy ? ` from runway ${rwy}` : ""}. Full power, rotate, climb out.`, say: `cleared for takeoff${rwy ? ` runway ${rwy}` : ""}` }];
  },
  (c, all) => {
    if (!/\bcleared to land\b/.test(c)) return null;
    const rwy = runwayFor(c, all);
    return [{ type: "land", runway: rwy, do: `Land${rwy ? ` on runway ${rwy}` : ""}.`, say: `cleared to land${rwy ? ` runway ${rwy}` : ""}` }];
  },
  (c, all) => {
    if (!/\bline up and wait\b|\blineup and wait\b|\bposition and hold\b/.test(c)) return null;
    const rwy = runwayFor(c, all);
    return [{ type: "lineup", runway: rwy, do: `Enter${rwy ? ` runway ${rwy}` : " the runway"}, line up on the centre line and stop. Do NOT take off.`, say: `line up and wait${rwy ? ` runway ${rwy}` : ""}` }];
  },
  (c) => {
    if (!/\bgo around\b/.test(c)) return null;
    return [{ type: "goaround", do: "GO AROUND: full power, climb, gear up, follow the missed approach.", say: "going around" }];
  },
  (c) => {
    const m = /\bcleared (?:for )?(?:the )?(ils|rnav|visual|loc|localizer|vor)(?: approach)?(?:.*?runway\s+(\d{2}[LRC]?))?/.exec(c);
    if (!m) return null;
    const kind = m[1] === "localizer" ? "LOC" : m[1].toUpperCase();
    const rwy = m[2] || parseRunway(c);
    return [{ type: "approach", runway: rwy, do: `Fly the ${kind} approach${rwy ? ` to runway ${rwy}` : ""}: intercept and follow it down.`, say: `cleared ${kind} approach${rwy ? ` runway ${rwy}` : ""}` }];
  },
  // Ground
  (c) => {
    if (!/\bpush ?back\b|\bpush and start\b/.test(c) || !/\bapproved\b/.test(c)) return null;
    return [{ type: "pushback", do: "Push back now (and start engines if asked).", say: /start/.test(c) ? "push and start approved" : "pushback approved" }];
  },
  (c) => {
    if (!/\bstart ?up approved\b/.test(c)) return null;
    return [{ type: "startup", do: "Start your engines.", say: "start up approved" }];
  },
  (c) => {
    if (!/\bhold short\b/.test(c)) return null;
    const rwy = parseRunway(c);
    const twy = /\bhold short (?:of )?(?:taxiway )?([a-z]+\d?)\b/.exec(c);
    const what = rwy ? `runway ${rwy}` : twy ? letters(twy[1]).join("") || twy[1].toUpperCase() : "";
    return [{ type: "holdshort", runway: rwy, do: `STOP before ${what || "the runway"}. Do not cross the hold line.`, say: `hold short${what ? ` ${what}` : ""}` }];
  },
  (c) => {
    const m = /\bcross (?:runway\s+)?(\d{2}[LRC]?)/.exec(c);
    if (!m) return null;
    return [{ type: "cross", runway: m[1], do: `Cross runway ${m[1]} now, don't stop on it.`, say: `cross runway ${m[1]}` }];
  },
  (c) => {
    if (!/\btaxi\b/.test(c)) return null;
    const rwy = parseRunway(c);
    const to = rwy ? `runway ${rwy}` : (/\btaxi (?:to )?(?:the )?((?:gate|stand|parking|apron|ramp)(?: \w+)?)/.exec(c) || [])[1];
    const via = /\bvia\s+([a-z0-9 ,]+?)(?=$|\bhold\b|\bcross\b|\brunway\b)/.exec(c);
    const route = via ? letters(via[1]) : [];
    return [{ type: "taxi", runway: rwy, route, do: `Taxi${to ? ` to ${to}` : ""}${route.length ? ` via ${route.join(" → ")}` : ""}. Keep it under 20 knots.`, say: `taxi${to ? ` to ${to}` : ""}${route.length ? ` via ${route.join(", ")}` : ""}` }];
  },
  (c) => {
    if (!/\bvacate\b|\bexit (?:the )?runway\b/.test(c)) return null;
    const twy = /\b(?:via|at)\s+([a-z]+\d?)\b/.exec(c);
    const t = twy ? letters(twy[1]).join("") : "";
    return [{ type: "vacate", do: `Leave the runway${t ? ` at ${t}` : ""} as soon as you can.`, say: `vacate${t ? ` via ${t}` : ""}` }];
  },
  // Heading
  (c, all, ctx) => {
    // "turn left heading 270", "left turn heading 270", "make it heading 270", "turn left 270"
    const m = /\b(?:turn\s+(left|right)\s+|(left|right)\s+turn\s+)?(?:fly\s+|turn\s+|continue\s+|make it\s+)?(?:(left|right)\s+)?heading\s+(\d{1,3})\b/.exec(c)
      || /\b(?:turn\s+(left|right)|(left|right)\s+turn)()\s+(\d{3})\b/.exec(c);
    if (!m) return null;
    const hdg = +m[4];
    if (hdg > 360) return null;
    const said = m[1] || m[2] || m[3] || null;
    const dir = said || turnDir(ctx.flight?.heading, hdg);
    const from = ctx.flight?.heading != null ? ` (now ${pad3(Math.round(ctx.flight.heading))})` : "";
    return [{ type: "heading", heading: hdg, dir, do: `Turn ${dir ? dir.toUpperCase() + " " : ""}to heading ${pad3(hdg)}${from}.`, say: `${said ? said + " " : "fly "}heading ${pad3(hdg)}` }];
  },
  // Direct to a waypoint
  (c) => {
    const m = /\b(?:proceed |fly |cleared )?direct(?: to)?\s+([a-z]{3,5})\b/.exec(c);
    if (!m || /\bdirect to the\b/.test(c)) return null;
    const wp = m[1].toUpperCase();
    return [{ type: "direct", fix: wp, do: `Fly direct to ${wp}.`, say: `direct ${wp}` }];
  },
  // Altitude
  (c, all, ctx) => {
    let m = /\b(climb|descend)(?:\s+and maintain|\s+to|\s+via)?\s+(?:altitude\s+)?(fl\d{2,3}|\d{3,5})\b/.exec(c)
      || /\b(maintain|stay at)\s+(?:altitude\s+)?(fl\d{2,3}|\d{3,5})(?!\s*knots)\b/.exec(c);
    const go = /\bgo (up|down) to\s+(fl\d{2,3}|\d{3,5})\b/.exec(c); // "go up to 5000"
    if (!m && go) m = [go[0], go[1] === "up" ? "climb" : "descend", go[2]];
    if (!m) return null;
    if (m[1] === "stay at") m = [m[0], "maintain", m[2]];
    const a = parseAlt(m[2]);
    if (!a) return null;
    let verb = m[1];
    if (verb === "maintain" && ctx.flight?.altitude != null) verb = a.ft > ctx.flight.altitude + 150 ? "climb" : a.ft < ctx.flight.altitude - 150 ? "descend" : "maintain";
    const now = ctx.flight?.altitude != null ? ` (now ${Math.round(ctx.flight.altitude / 100) * 100} ft)` : "";
    const how = verb === "maintain" ? "Stay at" : `${cap(verb)} to`;
    return [{ type: "altitude", ft: a.ft, do: `${how} ${a.fl ? `FL${a.fl}` : fmtAlt(a.ft)}${now}.`, say: `${verb === "maintain" ? "maintain" : verb + " and maintain"} ${sayAlt(a)}` }];
  },
  // Speed
  (c) => {
    if (/\bresume (?:normal )?speed\b|\bno speed restrictions?\b/.test(c)) return [{ type: "speed", do: "Speed restriction removed: fly your normal speed.", say: "resume normal speed" }];
    const m = /\b(?:(reduce|increase|maintain)\s+)?speed\s+(?:to\s+)?(\d{2,3})(?:\s*knots)?\b/.exec(c) || /\b(maintain|reduce to|increase to|slow to|slow down to)\s+(\d{2,3})\s*knots\b/.exec(c);
    if (!m) return null;
    const kt = +m[2];
    const verb = m[1] ? m[1].replace(/ (down )?to$/, "").replace("slow", "reduce") : "";
    return [{ type: "speed", kt, do: `${verb ? cap(verb) + " speed" : "Fly speed"} ${kt} knots.`, say: `speed ${kt}` }];
  },
  // Squawk
  (c) => {
    if (/\bsquawk ident\b|\bident\b/.test(c) && !/\bsquawk\s+[0-7]{4}/.test(c)) return [{ type: "ident", do: "Press IDENT on your transponder.", say: "ident" }];
    const m = /\bsquawk\s+([0-7]{4})\b/.exec(c);
    if (!m) return null;
    return [{ type: "squawk", code: m[1], do: `Set your transponder to ${m[1]}.`, say: `squawk ${m[1]}` }];
  },
  // Altimeter
  (c) => {
    const m = /\b(?:qnh|altimeter)\s+(\d{3,4}(?:\.\d+)?)\b/.exec(c);
    if (!m) return null;
    return [{ type: "altimeter", value: m[1], do: `Set altimeter ${m[1]}.`, say: `${/qnh/.test(c) ? "QNH" : "altimeter"} ${m[1]}` }];
  },
  // Frequency change
  (c) => {
    const f = parseFreq(c);
    const m = /\b(contact|monitor|switch to|call)\b/.exec(c);
    if (!m && !(f && FACILITY.test(c))) return null;
    const fac = /\b([a-z]+)\s+(delivery|clearance|ground|tower|approach|departure|director|center|centre|control|radar)\b/.exec(c);
    const name = fac ? `${/^(contact|monitor|to|call)$/.test(fac[1]) ? "" : cap(fac[1])} ${cap(fac[2])}`.trim() : "";
    if (!f && !name) return null;
    return [{ type: "contact", freq: f, facility: name, do: `Switch to ${name || "the next controller"}${f ? ` on ${f}` : ""} and check in.`, say: `${name ? name + " " : ""}${f || ""}`.trim() }];
  },
  (c) => {
    if (!/\bfrequency change approved\b/.test(c)) return null;
    return [{ type: "freqchange", do: "You can leave this frequency.", say: "frequency change approved, good day" }];
  },
  (c) => {
    if (!/\bresume own nav(?:igation)?\b/.test(c)) return null;
    return [{ type: "ownnav", do: "Navigate yourself again: back on your route.", say: "resume own navigation" }];
  },
  (c) => {
    if (!/\bhold (?:your )?position\b/.test(c)) return null;
    return [{ type: "holdpos", do: "STOP where you are and wait.", say: "holding position" }];
  },
  (c) => {
    const m = /\bexpect\s+(.+)/.exec(c);
    if (!m) return null;
    const rwy = parseRunway(c);
    const what = rwy ? (/\b(ils|rnav|visual)\b/.exec(c) ? `${/\b(ils|rnav|visual)\b/.exec(c)[1].toUpperCase()} approach runway ${rwy}` : `runway ${rwy}`) : m[1];
    return [{ type: "expect", do: `Plan for ${what}.`, say: `expect ${what}` }];
  },
  (c) => {
    const m = /\breport\s+(.+)/.exec(c);
    if (!m) return null;
    return [{ type: "report", do: `Tell ATC when you're ${m[1].replace(/^(when )?/, "")}.`, say: "wilco" }];
  },
  (c, all, ctx) => {
    if (/\b(?:say|confirm) (?:your )?altitude\b/.test(c)) return [{ type: "sayalt", do: "ATC wants your altitude.", say: ctx.flight?.altitude != null ? `${Math.round(ctx.flight.altitude / 100) * 100} feet` : "(say your altitude)" }];
    if (/\bsay heading\b/.test(c)) return [{ type: "sayhdg", do: "ATC wants your heading.", say: ctx.flight?.heading != null ? `heading ${pad3(Math.round(ctx.flight.heading))}` : "(say your heading)" }];
    if (/\bsay (?:speed|airspeed)\b/.test(c)) return [{ type: "sayspd", do: "ATC wants your speed.", say: ctx.flight?.groundSpeed != null ? `${Math.round(ctx.flight.groundSpeed)} knots` : "(say your speed)" }];
    return null;
  },
  (c) => {
    if (!/\bradar contact\b|\bidentified\b/.test(c)) return null;
    return [{ type: "info", do: "ATC sees you on radar. Keep flying as you are.", say: null }];
  },
  (c) => {
    if (!/\btraffic\b/.test(c)) return null;
    return [{ type: "traffic", do: "Look out for the traffic ATC mentioned.", say: /\bin sight\b/.test(c) ? "traffic in sight" : "looking out" }];
  },
];

// Split a call into clauses: commas, "then", " and " between instructions.
// A new instruction starting straight after the end of another one, with no
// comma: "... on 120.6 squawk 2641", "reset squawk 7456 stay at 11000".
const NEXT_VERB = /(\d[a-z]?|feet|knots|approved|identified|radar contact|position|east|west|north|south|sid|nav|navigation|altitude)\s+(?:and\s+)?(?=(?:contact|monitor|call|squawk|reset squawk|climb|descend|maintain|stay at|go up|go down|turn|fly|proceed|direct|taxi|hold short|line up|cleared|identified|radar contact|push|go around|say|confirm|resume|reduce|increase|slow|expect|report|runway \d+\w? cleared)\b)/g;

function clauses(text) {
  const parts = text
    .replace(NEXT_VERB, "$1 , ")
    .split(/ , | then |(?<=\d[a-z]?) and (?=(?:climb|descend|maintain|turn|fly|contact|squawk|reduce|increase|cleared|expect|report|line|hold|taxi|proceed|direct))/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    // "runway 25L , cleared for takeoff": the runway belongs to the next clause.
    if (prev && /^runway \S+$/.test(prev)) { out[out.length - 1] = `${prev} ${p}`; continue; }
    // "via alpha , bravo 2": taxiway names continue the route.
    if (prev && /\bvia\b/.test(prev) && TWY_WORD.test(p)) { out[out.length - 1] = `${prev} , ${p}`; continue; }
    out.push(p);
  }
  return out;
}

export function understand(transcript, { callsign = "", flight = null } = {}) {
  const heard = normalize(transcript);
  const me = splitCallsign(callsign);
  const addr = addressee(heard, me);
  const ctx = { flight, consumedAll: false };
  const items = [];
  for (const c of clauses(heard)) {
    if (ctx.consumedAll) break;
    for (const rule of RULES) {
      const r = rule(c, heard, ctx);
      if (r) { items.push(...r); break; }
    }
  }
  // Drop duplicates (a clause matched twice through "and")
  const seen = new Set();
  const uniq = items.filter((i) => { const k = i.type + i.say; if (seen.has(k)) return false; seen.add(k); return true; });
  const says = uniq.map((i) => i.say).filter(Boolean);
  const cs = spokenCallsign(callsign);
  let readback = "";
  if (says.length) readback = `${cap(says.join(", "))}${cs ? `, ${cs}` : ""}`;
  else if (uniq.length) readback = cs ? `Roger, ${cs}` : "Roger";
  return { forMe: addr.forMe, items: uniq, readback, heard, unknown: uniq.length === 0 };
}
