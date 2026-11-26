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
// "Speedbird-208" -> { name: "speedbird", num: "208", suffix: "" }
// "JetBlue 29W"   -> { name: "jetblue",   num: "29",  suffix: "w" }
export function splitCallsign(cs) {
  const s = String(cs || "").toLowerCase().replace(/[-_]/g, " ").replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2");
  const words = s.split(/\s+/).filter(Boolean);
  const firstNum = words.findIndex((w) => /^\d+$/.test(w));
  const name = (firstNum > 0 ? words.slice(0, firstNum) : words.filter((w) => !/\d/.test(w)).slice(0, 1)).join("");
  const num = (s.match(/\d+/g) || []).join("");
  const after = firstNum >= 0 ? words.slice(firstNum + 1).filter((w) => !/\d/.test(w)) : [];
  const suffix = after.map((w) => (PHONETIC[w] ? PHONETIC[w].toLowerCase() : w)).filter((w) => /^[a-z]$/.test(w)).join("");
  // The name as a pattern that allows spaces between its words ("sky orenji").
  const nameRe = name.split("").join("\\s?");
  return { name, num, suffix, nameRe };
}

const PHONETIC_WORD = Object.fromEntries(Object.entries(PHONETIC).filter(([w]) => !["alfa", "juliett", "whisky"].includes(w)).map(([w, l]) => [l.toLowerCase(), w]));

// Readback style: "Speedbird 208", "Jetblue 29 Whiskey"
export function spokenCallsign(cs) {
  const { name, num, suffix } = splitCallsign(cs);
  if (!name && !num) return "";
  const letters = suffix.split("").filter(Boolean).map((l) => cap(PHONETIC_WORD[l] || l.toUpperCase()));
  return [cap(name), num, ...letters].filter(Boolean).join(" ");
}

// Is this call for one of my callsigns? Returns which one ATC used.
function addressee(text, mes) {
  // Callsign is normally first: "speedbird 208 , turn left ...", after any
  // filler ("copy , jetblue 29 whiskey , ...", "correction , ...").
  const parts = text.split(" , ");
  while (parts.length > 1 && /^(?:copy|roger|okay|ok|correction|uh|um|er|and|so|alright|right|affirm|affirmative|negative|sorry|my bad|disregard)(?: that)?$/.test(parts[0].trim())) parts.shift();
  const head = parts[0].split(" ").slice(0, 5).join(" ");
  const nums = head.match(/\b\d{2,5}\b/g) || [];
  const tail = text.split(" , ").pop();
  for (const me of mes) {
    if (!me.num) continue;
    // A letter suffix ("29 whiskey") must be heard too; short numbers also need the name.
    const sfx = me.suffix ? new RegExp(`\\b${me.num}\\s*(?:${me.suffix.split("").map((l) => `${l}|${PHONETIC_WORD[l] || l}`).join("|")})\\b`) : null;
    const short = me.num.length < 3;
    const ok = (s) => (sfx ? sfx.test(s) : short ? new RegExp(`\\b${me.nameRe}\\s*${me.num}\\b`).test(s) : new RegExp(`\\b${me.num}\\b`).test(s));
    if (ok(head) || ok(tail)) return { forMe: true, said: head, me };
    // Number split up by speech-to-text: "jet blue 30 32" -> 3032
    const joined = (head.match(/\b\d{1,4}\b/g) || []).join("");
    if (!sfx && me.num.length >= 3 && joined.includes(me.num)) return { forMe: true, said: head, me };
    if (new RegExp(`\\b${me.nameRe}\\s*${me.num}\\b`).test(text)) return { forMe: true, said: null, me };
  }
  // Someone else's callsign up front: a word + a number
  const first = head.split(" ");
  if (nums.length && (AIRLINE_WORDS.has(first[0]) || /^[a-z]+$/.test(first[0])) && /^\d{2,5}$/.test(first[1] || "")) return { forMe: false, said: head };
  return { forMe: null, said: null };
}

// --- airports ----------------------------------------------------------------
// Names as said on the radio (and as speech-to-text writes them) -> ICAO.
const AIRPORT_NAMES = [
  [/^(?:greater )?rockford|^rock ?ford/, "IRFD"], [/^perth|^per\b|^pert\b/, "IPPH"], [/^tokyo/, "ITKO"],
  [/^larnaca|^lanarca/, "ILAR"], [/^izolirani|^izzy/, "IZOL"], [/^paphos|^pathos/, "IPAP"], [/^mellor|^mela/, "IMLR"],
  [/^keflavik|^keflavic/, "IKFL"], [/^sauthemptona|^southampton/, "ISAU"], [/^grindavik/, "IGRV"],
  [/^saint barth|^st barth|^saint bart/, "IBTH"], [/^lukla/, "ILKL"], [/^barra/, "IBAR"], [/^henstridge/, "IHEN"],
  [/^mcconnell|^mc connell/, "IIAB"], [/^(?:air base )?garry|^gary/, "IGAR"], [/^boltic/, "IBLT"],
  [/^scampton|^raf scampton/, "ISCM"], [/^(?:al )?najaf/, "IJAF"], [/^saba/, "IDCS"], [/^skopelos/, "ISKP"],
  [/^training cent/, "ITRC"], [/^pingeyri|^ping/, "ITEY"], [/^bird island/, "IBRD"], [/^ufo/, "IUFO"],
];
function airportFor(text) {
  const t = String(text || "").trim().replace(/^the /, "");
  if (/^i[a-z]{3}$/.test(t)) return t.toUpperCase();
  for (const [re, icao] of AIRPORT_NAMES) if (re.test(t)) return icao;
  // Something else that looks like a place name (one or two words).
  if (/^[a-z]{3,}(?: [a-z]{3,})?$/.test(t) && !/\b(?:go|you|me|us|it|them|that|this|proceed|continue|climb|descend)\b/.test(t)) return t.replace(/\b\w/g, (ch) => ch.toUpperCase());
  return null;
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
  // "030" / "050": hundreds of feet, the way ATC says low altitudes.
  m = /\b(0\d{2})\b/.exec(s);
  if (m && +m[1] >= 5) return { ft: +m[1] * 100 };
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
  // "you are clear to Perth International as filed, expect 1000, ... squawk code 6741"
  (c, all, ctx) => {
    // An airport spelled out letter by letter: "cleared to i l k l"
    const spelled = /\bclear(?:ed)? to ([a-z]) ([a-z]) ([a-z]) ([a-z])\b/.exec(c);
    if (spelled) { const joined = `cleared to ${spelled.slice(1).join("")}`; c = c.replace(spelled[0], joined); all = all.replace(spelled[0], joined); }
    const m = /\bclear(?:ed)? to\s+((?!land|cross|enter|push|taxi|take|line|the runway|runway|depart|go\b)[a-z][a-z ]*?)(?=\s+(?:airport|international|intl|as filed|via|on|with|,|then)\b|\s*,|$)/.exec(c);
    if (!m) return null;
    const dest = airportFor(m[1]);
    if (!dest) return null;
    const asFiled = /\bas filed\b/.test(all);
    const via = asFiled ? null : /\bvia\s+(.+?)(?=$| , |\bdeparture\b|\brunway\b|\binitial|\bclimb|\bsquawk|\bexpect)/.exec(all);
    const dep = /\b([a-z]+ ?\d[a-z]?)\s+departure\b/.exec(all);
    const rwy = parseRunway(all);
    const init = /\b(?:initial(?:ly)? (?:climb|altitude)|climb (?:and maintain|to)?|maintain)\s+(fl\d{2,3}|\d{3,5}|0\d{2})\b/.exec(all);
    const expect = /\bexpect\s+(?:flight level\s+|fl)?(fl\d{2,3}|\d{2,5})\b/.exec(all);
    const sq = /\bsquawk\s+(?:code\s+)?([0-7]{4})\b/.exec(all);
    const fmt = (v) => (v.startsWith("fl") ? v.toUpperCase() : /^0\d\d$/.test(v) ? String(+v * 100) : /^\d{2,3}$/.test(v) && +v < 500 ? `FL${v.padStart(3, "0")}` : v);
    const parts = [`cleared to ${dest}${asFiled ? " as filed" : ""}`];
    if (dep) parts.push(`${dep[1].toUpperCase()} departure`);
    if (via && !(dep && via[1].replace(/W/g, "").includes(dep[1].replace(/W/g, "")))) parts.push(`via ${via[1].trim()}`);
    if (rwy) parts.push(`runway ${rwy}`);
    if (init) parts.push(`climb ${fmt(init[1])}`);
    if (expect) parts.push(`expect ${fmt(expect[1])}`);
    // "departure (frequency) will be 123.3"
    const depFreq = /\bdeparture(?: frequency)?(?: (?:will be|is|on))?\s+(1[1-3]\d\.\d{1,3})\b/.exec(all);
    if (depFreq) parts.push(`departure ${depFreq[1]}`);
    if (sq) parts.push(`squawk ${sq[1]}`);
    ctx.consumedAll = true; // the whole call is one clearance
    const doText = [`IFR clearance to ${dest}${asFiled ? " (your filed route)" : ""}`, rwy && `departing runway ${rwy}`, init && `first climb to ${fmt(init[1])}${/^FL/.test(fmt(init[1])) ? "" : " ft"}`, expect && `expect ${fmt(expect[1])} later`].filter(Boolean).join(", ");
    return [{ type: "clearance", dest, runway: rwy, squawk: sq?.[1], do: `${doText}.${sq ? ` Set squawk ${sq[1]}.` : ""}`, say: parts.join(", ") }];
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
    if (!/\bhold short\b|\bhold at\b/.test(c)) return null;
    c = c.replace(/\bhold at\b/, "hold short of"); // "hold at B2"
    const rwy = parseRunway(c);
    // "hold short of K5", "hold short runway 25 at K5"
    const twyWord = (/\bhold short (?:of )?(?:taxiway )?([a-z]\d{1,2}|[a-z]+(?: \d{1,2}\b)?)\b/.exec(c) || [])[1];
    const twy = twyWord && twyWord !== "runway" ? letters(twyWord).join("") : "";
    const at = (/\b(?:at|on)\s+(?:taxiway\s+)?([a-z]\d{0,2}|[a-z]+)\b/.exec(c) || [])[1];
    const atTwy = at ? letters(at).join("") : "";
    const what = rwy ? `runway ${rwy}${atTwy ? ` at ${atTwy}` : ""}` : twy;
    return [{ type: "holdshort", runway: rwy, taxiway: atTwy || twy || null, do: `STOP before ${what || "the runway"}. Do not cross the hold line.`, say: `hold short${what ? ` ${what}` : ""}` }];
  },
  (c) => {
    const m = /\bcross (?:runway\s+)?(\d{2}[LRC]?)/.exec(c);
    if (!m) return null;
    const at = (/\b(?:at|via)\s+(?:taxiway\s+)?([a-z]\d{0,2}|[a-z]+)\b/.exec(c) || [])[1];
    const t = at ? letters(at).join("") : "";
    return [{ type: "cross", runway: m[1], do: `Cross runway ${m[1]}${t ? ` at ${t}` : ""} now, don't stop on it.`, say: `cross runway ${m[1]}${t ? ` at ${t}` : ""}` }];
  },
  (c) => {
    if (!/\btaxi\b/.test(c)) return null;
    const rwy = parseRunway(c);
    // "taxi to gate 10", "taxi to stand 4b", "taxi to the apron"
    const place = /\b(?:taxi|to)\s+(?:to\s+)?(?:the\s+)?(gate|stand|parking|apron|ramp|spot)(?:\s+(?!via\b)([a-z]?\d{1,3}[a-z]?|[a-z]))?\b/.exec(c);
    const gate = place && place[2] ? place[2].toUpperCase() : null;
    const to = rwy ? `runway ${rwy}` : place ? `${place[1]}${gate ? ` ${gate}` : ""}` : null;
    const via = /\bvia\s+([a-z0-9 ,]+?)(?=$|\bhold\b|\bcross\b|\brunway\b)/.exec(c);
    const route = via ? letters(via[1]) : [];
    return [{ type: "taxi", runway: rwy, gate: gate ? `${place[1]} ${gate}` : null, route, do: `Taxi${to ? ` to ${to}` : ""}${route.length ? ` via ${route.join(" → ")}` : ""}. Keep it under 20 knots.`, say: `taxi${to ? ` to ${to}` : ""}${route.length ? ` via ${route.join(", ")}` : ""}` }];
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
    if (/\bsquawk ident\b|\bident\b/.test(c) && !/\bsquawk\s+(?:code\s+)?[0-7]{4}/.test(c)) return [{ type: "ident", do: "Press IDENT on your transponder.", say: "ident" }];
    const m = /\bsquawk\s+(?:code\s+)?([0-7]{4})\b/.exec(c); // "squawk code 6741"
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
    // Only things worth planning for: a runway, an approach, an altitude, vectors.
    if (!/\bexpect\b/.test(c)) return null;
    const rwy = parseRunway(c);
    const appr = /\b(ils|rnav|visual)\b/.exec(c);
    const alt = /\bexpect\s+(?:flight level\s+|fl)?(fl\d{2,3}|\d{3,5})\b/.exec(c);
    let what = null;
    if (rwy) what = appr ? `${appr[1].toUpperCase()} approach runway ${rwy}` : `runway ${rwy}`;
    else if (alt) what = alt[1].startsWith("fl") ? alt[1].toUpperCase() : +alt[1] < 500 ? `FL${alt[1].padStart(3, "0")}` : alt[1];
    else if (/\bexpect (?:radar )?vectors\b/.test(c)) what = "vectors";
    if (!what) return null;
    return [{ type: "expect", do: `Plan for ${what}${alt && !rwy ? " later (don't climb to it yet)" : ""}.`, say: `expect ${what}` }];
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
    // "hold short , bravo 2": the taxiway belongs to the hold short.
    if (prev && /\bhold (?:short|at)(?: of)?$/.test(prev) && TWY_WORD.test(p)) { out[out.length - 1] = `${prev} ${p}`; continue; }
    if (prev && /\bvia\b/.test(prev) && TWY_WORD.test(p)) { out[out.length - 1] = `${prev} , ${p}`; continue; }
    out.push(p);
  }
  return out;
}

export function understand(transcript, { callsign = "", aliases = [], flight = null } = {}) {
  const heard = normalize(transcript);
  // Every name you go by: in-game callsign, the one in your flight plan, and
  // whatever you told the app ATC calls you.
  const mes = [callsign, ...aliases].filter(Boolean).map((raw) => ({ raw, ...splitCallsign(raw) })).filter((m) => m.num);
  const addr = addressee(heard, mes);
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
  // Read back with the callsign ATC used (else the one you said ATC calls you).
  const cs = spokenCallsign(addr.me ? addr.me.raw : (aliases.find(Boolean) || callsign));
  let readback = "";
  if (says.length) readback = `${cap(says.join(", "))}${cs ? `, ${cs}` : ""}`;
  else if (uniq.length) readback = cs ? `Roger, ${cs}` : "Roger";
  // Who it was for, when it was someone else ("shamrock 4512").
  const to = addr.forMe === false && addr.said ? addr.said.split(" ").slice(0, 2).map(cap).join(" ") : null;
  return { forMe: addr.forMe, to, items: uniq, readback, heard, unknown: uniq.length === 0 };
}
