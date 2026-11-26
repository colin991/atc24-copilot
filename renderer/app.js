// The overlay: hears a call -> text -> what to do + what to say back.
import { understand, spokenCallsign } from "../src/atc.js";
import { buildCalls } from "../src/calls.js";
import { targets, track, nextPhase, phaseTip } from "../src/guide.js";
import { closestEmptyGate } from "../src/gates.js";
import { Listener, listInputs, wavToFloat } from "./audio.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// In a normal browser (for testing the page) there's no app around it.
const app = window.copilot || {
  aircraft: async () => null, taxiLabels: async () => null, atis: async () => null, airports: async () => null, plan: async () => null, sttStatus: async () => ({ fast: false }), transcribe: async () => ({ error: "browser" }),
  version: async () => "dev", setClickThrough() {}, minimize() {}, quit() {}, installUpdate() {}, on() {},
  checkUpdate: async () => ({ state: "dev", version: "dev" }), updateStatus: async () => ({ state: "dev", version: "dev" }),
};

// ---- settings ---------------------------------------------------------------
const S = {
  callsign: localStorage.getItem("callsign") || "",
  atcCs: localStorage.getItem("atcCs") || "",
  sttQuality: localStorage.getItem("sttQuality") || "auto",
  server: localStorage.getItem("server") || "main",
  source: localStorage.getItem("source") || "system",
  sens: +(localStorage.getItem("sens") || 3),
  onlyMe: localStorage.getItem("onlyMe") === "1",
  opacity: +(localStorage.getItem("opacity") || 0.82),
  listening: true,
  flight: null,      // your aircraft from the radar
  flightCs: "",      // its callsign, e.g. "Speedbird-208"
  fast: false,       // online speech-to-text available
  plan: null,        // your flight plan (from the radar's live server)
  atis: [],          // ATIS for every airport
  airports: null,    // airport positions
  recent: [],        // ATC instructions for you this flight (for "My calls")
  phase: "unknown",  // parked / taxiing / airborne / landing / vacate / stopped / taxiin / parkedin
};
const save = (k, v) => { S[k] = v; localStorage.setItem(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)); };

// ---- your flight, from the radar ---------------------------------------------
async function pollFlight() {
  const q = S.callsign.trim().toLowerCase();
  if (q) {
    const all = await app.aircraft(S.server);
    if (all) {
      S.all = all; // everyone, for finding an empty gate
      let hit = null;
      for (const [cs, a] of Object.entries(all)) {
        if (cs.toLowerCase() === q || (a.playerName || "").toLowerCase() === q) { hit = [cs, a]; break; }
      }
      // Loose match: "speedbird 208" vs "Speedbird-208"
      if (!hit) { const n = q.replace(/[^a-z0-9]/g, ""); hit = Object.entries(all).find(([cs]) => cs.toLowerCase().replace(/[^a-z0-9]/g, "") === n) || null; }
      S.flight = hit ? hit[1] : null;
      S.flightCs = hit ? hit[0] : "";
    }
  } else { S.flight = null; S.flightCs = ""; }
  renderFlight();
}
function renderFlight() {
  const f = S.flight;
  if (!S.callsign.trim()) $("flight").innerHTML = "Set your callsign in ⚙ settings";
  else if (!f) $("flight").innerHTML = `<b>${esc(S.callsign)}</b> · not on the radar right now`;
  else $("flight").innerHTML = `<b>${esc(S.flightCs)}</b> · ${esc(f.aircraftType || "")} · ${f.isOnGround ? "on ground" : `${Math.round(f.altitude).toLocaleString()} ft`} · HDG ${String(Math.round(f.heading)).padStart(3, "0")} · ${Math.round(f.speed ?? f.groundSpeed ?? 0)} kt${f.speed != null && Math.abs((f.speed || 0) - (f.groundSpeed || 0)) > 15 ? ` (GS ${Math.round(f.groundSpeed || 0)})` : ""}`;
}
const myCallsign = () => S.flightCs || S.callsign;
// Other names ATC may use: what you typed in settings, and the callsign
// filed in your flight plan (e.g. "JetBlue 29W" for in-game "JetBloo-3032").
const aliases = () => [S.atcCs, S.plan?.filed].filter((x) => x && x.trim());
// The callsign for readbacks and your own calls: the one ATC uses.
const sayCallsign = () => aliases()[0] || myCallsign();

// ---- speech to text ------------------------------------------------------------
let worker = null, workerReady = false, nextId = 1;
const pending = new Map();
function localWhisper(wav) {
  if (!worker) {
    worker = new Worker(new URL("./whisper-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.status === "loading") setStt("built-in (loading speech model, first time downloads it)…");
      if (m.status === "ready") { workerReady = true; setStt(`built-in (${m.device === "gpu" ? "graphics card" : "CPU"}, ${m.quality})`); }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
  }
  const id = nextId++;
  return new Promise((resolve) => { pending.set(id, resolve); worker.postMessage({ id, audio: wavToFloat(wav), quality: S.sttQuality }); });
}
function setStt(text) { $("sttMode").textContent = text; $("mode").textContent = /fast/.test(text) ? "fast" : /built-in/.test(text) ? "local" : ""; }

async function transcribe(wav) {
  if (S.fast) {
    const r = await app.transcribe(wav);
    if (r.text !== undefined) return r;
    if (r.status === 503) { S.fast = false; setStt("built-in (on this PC)"); }
  }
  return localWhisper(wav);
}

// Whisper sometimes "hears" words in pure noise.
const JUNK = /^(you|thank you\.?|thanks for watching!?|bye\.?|\.+|music|\[.*\]|\(.*\))$/i;

// ---- a call came in ----------------------------------------------------------------
let busy = 0;
async function onClip(wav) {
  busy++; setDot();
  try {
    const r = await transcribe(wav);
    if (!r || r.error || !r.text || JUNK.test(r.text.trim()) || r.text.trim().split(/\s+/).length < 2) return;
    onText(r.text);
  } finally { busy--; setDot(); }
}

// ATC often pauses mid-call ("...expect 3000" ... "squawk 6741"), which cuts
// one call into pieces. A piece that comes within a few seconds and doesn't
// start with a callsign is joined to the call before it and read again as one.
const JOIN_MS = 5000;
let last = null; // { text, at, result }
function onText(text) {
  const now = Date.now();
  if (last && now - last.at < JOIN_MS) {
    const alone = understand(text, { callsign: myCallsign(), aliases: aliases(), flight: S.flight });
    if (alone.forMe !== true && !alone.to) {
      undo(last.result);
      text = `${last.text} , ${text}`;
    }
  }
  const result = handle(text, !!(last && text.startsWith(last.text)));
  last = { text, at: Date.now(), result };
}
// Take back what the previous piece added, before showing the joined call.
function undo(res) {
  if (!res) return;
  if (res.el) res.el.remove();
  if (res.pushed) S.recent.splice(-res.pushed, res.pushed);
}

function handle(text, joined = false) {
  const r = understand(text, { callsign: myCallsign(), aliases: aliases(), flight: S.flight });
  // Only a call with YOUR callsign gets the big DO / SAY card. Calls for
  // someone else, or where no callsign was heard, go in the list below,
  // greyed out, and never get a readback with your callsign on it.
  if (r.forMe !== true) {
    return { el: !S.onlyMe && !r.unknown ? addOther(r) : null, pushed: 0 };
  }
  showNow(r, joined);
  let pushed = 0;
  if (!r.unknown) {
    // A new clearance starts a new flight.
    if (r.items.some((i) => i.type === "clearance")) S.recent = [];
    S.recent.push(...r.items);
    pushed = r.items.length;
    S.recent = S.recent.slice(-30);
    renderCalls();
    renderLive();
  }
  return { el: null, pushed };
}

function addOther(r) {
  const el = document.createElement("div");
  el.className = "past other";
  const what = r.items.map((i) => i.say).filter(Boolean).join(", ");
  el.innerHTML = `${r.to ? `For <b>${esc(r.to)}</b>` : "<b>No callsign</b>"} · ${esc(what || r.heard)}`;
  el.title = `Heard: ${r.heard}`;
  $("history").prepend(el);
  while ($("history").children.length > 12) $("history").lastChild.remove();
  return el;
}

function showNow(r, joined = false) {
  const card = $("now");
  // Move the current one into history first (not when it's the same call, joined up).
  if (card.dataset.payload && !joined) addHistory(JSON.parse(card.dataset.payload), true);
  card.dataset.at = String(Date.now());
  card.classList.remove("stale");
  card.dataset.payload = JSON.stringify(r);
  card.classList.remove("empty", "fresh", "other");
  void card.offsetWidth; // restart the animation
  card.classList.add("fresh");
  if (r.forMe === false) card.classList.add("other");
  const cs = spokenCallsign(myCallsign());
  $("doList").innerHTML = r.unknown
    ? `<li class="muted">Not sure what that was. Ask ATC to say again.</li>`
    : r.items.map((i) => `<li>${esc(i.do)}</li>`).join("");
  const say = r.unknown ? `Say again${cs ? `, ${cs}` : ""}` : r.readback;
  $("say").textContent = r.forMe === false ? "(not for you)" : say || "—";
  $("say").classList.toggle("muted", r.forMe === false || !say);
  $("heard").textContent = `Heard: “${r.heard}”${r.forMe === null ? " (no callsign heard)" : ""}`;
}

function addHistory(r, mine) {
  const el = document.createElement("div");
  el.className = "past" + (mine && r.forMe !== false ? " mine" : "");
  el.innerHTML = r.unknown ? esc(r.heard) : `<b>${esc(r.readback || r.items.map((i) => i.say).join(", "))}</b>${r.forMe === false ? " · not for you" : ""}`;
  el.title = r.heard;
  $("history").prepend(el);
  while ($("history").children.length > 12) $("history").lastChild.remove();
}

// ---- listening ------------------------------------------------------------------
const listener = new Listener({
  onClip,
  sensitivity: S.sens,
  onLevel: (rms, floor, active) => {
    $("level").style.width = `${Math.min(100, Math.sqrt(rms) * 220)}%`;
    $("floor").style.left = `${Math.min(100, Math.sqrt(floor * S.sens) * 220)}%`;
    hearing = active; setDot();
  },
});
let hearing = false, audioOk = false;
function setDot() {
  const d = $("dot");
  d.className = "dot " + (!audioOk ? "off" : !S.listening ? "" : busy || hearing ? "hear" : "on");
  d.title = !audioOk ? "No audio, check ⚙ Listen to" : !S.listening ? "Paused" : busy ? "Working it out…" : "Listening";
  $("listenBtn").textContent = S.listening ? "❚❚" : "▶";
}
async function startAudio() {
  try { await listener.start(S.source); audioOk = true; }
  catch (e) { audioOk = false; $("heard").textContent = `Can't listen: ${e.message || e}`; }
  setDot();
}
function setListening(on) { S.listening = on; listener.paused = !on; setDot(); }

// ---- settings drawer ---------------------------------------------------------------
async function fillSources() {
  const sel = $("source");
  const mics = await listInputs();
  sel.innerHTML = `<option value="system">System audio (game + Discord)</option><option value="mic">Default microphone</option>` +
    mics.filter((m) => m.id !== "default" && m.id !== "communications").map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join("");
  sel.value = [...sel.options].some((o) => o.value === S.source) ? S.source : "system";
}
function bindSettings() {
  $("callsign").value = S.callsign;
  $("atcCs").value = S.atcCs;
  $("sttQuality").value = S.sttQuality;
  $("sttQuality").addEventListener("change", (e) => { save("sttQuality", e.target.value); if (!S.fast) warmUp(); });
  $("atcCs").addEventListener("change", (e) => { save("atcCs", e.target.value.trim()); renderCalls(); showAtcHint(); });
  $("callsign").addEventListener("change", (e) => { save("callsign", e.target.value.trim()); pollFlight(); });
  $("server").value = S.server;
  $("server").addEventListener("change", (e) => { save("server", e.target.value); pollFlight(); });
  $("source").addEventListener("change", (e) => { save("source", e.target.value); startAudio(); });
  $("sens").value = S.sens; $("sensVal").textContent = S.sens.toFixed(1);
  $("sens").addEventListener("input", (e) => { save("sens", +e.target.value); listener.sensitivity = S.sens; $("sensVal").textContent = S.sens.toFixed(1); });
  $("onlyMe").checked = S.onlyMe;
  $("onlyMe").addEventListener("change", (e) => save("onlyMe", e.target.checked));
  const applyOpacity = () => { document.documentElement.style.setProperty("--op", S.opacity); $("opVal").textContent = `${Math.round((1 - S.opacity) * 100)}%`; };
  $("opacity").value = S.opacity; applyOpacity();
  $("opacity").addEventListener("input", (e) => { save("opacity", +e.target.value); applyOpacity(); });
  $("test").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.value.trim()) { handle(e.target.value); e.target.select(); } });
}

$("settingsBtn").onclick = () => { $("settings").hidden = !$("settings").hidden; if (!$("settings").hidden) fillSources(); };
$("listenBtn").onclick = () => setListening(!S.listening);
$("minBtn").onclick = () => app.minimize();
$("closeBtn").onclick = () => app.quit();
$("say").onclick = () => {
  const t = $("say").textContent; if (!t || t === "—") return;
  navigator.clipboard.writeText(t).then(() => { $("say").classList.add("copied"); setTimeout(() => $("say").classList.remove("copied"), 1200); });
};
$("installUpdate").onclick = (e) => { e.preventDefault(); app.installUpdate(); };
app.on("click-through", (on) => document.body.classList.toggle("through", on));
app.on("toggle-listen", () => setListening(!S.listening));
app.on("update-ready", (v) => { $("update").hidden = false; $("update").firstChild.textContent = `Update v${v} ready · `; });

// ---- start -----------------------------------------------------------------------
bindSettings();
// ---- updates -------------------------------------------------------------------
function showUpdate(u) {
  if (!u) return;
  const ver = u.version ? `v${u.version}` : "";
  const t = $("updText"), b = $("updBtn");
  b.disabled = false; b.classList.remove("go"); b.textContent = "Check for updates";
  if (u.state === "checking") { t.innerHTML = `Version <b>${ver}</b> · <span class="busy">checking…</span>`; b.disabled = true; }
  else if (u.state === "latest") t.innerHTML = `Version <b>${ver}</b> · <span class="ok">up to date ✓</span>`;
  else if (u.state === "downloading") { t.innerHTML = `Version <b>${ver}</b> · <span class="busy">downloading v${esc(u.next || "")} ${u.percent ? `${u.percent}%` : "…"}</span>`; b.disabled = true; }
  else if (u.state === "ready") { t.innerHTML = `<span class="busy">v${esc(u.next || "")} is ready</span> (you have ${ver})`; b.textContent = "Restart to update"; b.classList.add("go"); }
  else if (u.state === "error") t.innerHTML = `Version <b>${ver}</b> · <span class="bad">couldn't check (offline?)</span>`;
  else if (u.state === "dev") { t.innerHTML = `Version <b>${ver || "dev"}</b> · test build, no updates`; b.disabled = true; }
  else t.innerHTML = `Version <b>${ver}</b>`;
  b.dataset.state = u.state;
}
$("updBtn").onclick = async () => {
  if ($("updBtn").dataset.state === "ready") return app.installUpdate();
  showUpdate({ ...(await app.updateStatus()), state: "checking" });
  showUpdate(await app.checkUpdate());
};
app.on("update-status", showUpdate);
app.updateStatus().then(showUpdate);
window.__showUpdate = showUpdate; // for checking the panel
// Load the built-in speech model straight away (it takes a few seconds), so
// the first real call isn't slow.
const warmUp = () => localWhisper(new Uint8Array(44 + 16000 * 2).buffer.slice(0)).catch(() => {});
app.sttStatus().then((s) => { S.fast = !!s.fast; setStt(S.fast ? "fast (online)" : "built-in (loading…)"); if (!S.fast) warmUp(); });
pollFlight();
setInterval(() => { pollFlight().then(() => { updatePhase(); renderLive(); renderCalls(); }); }, 3000); // the radar's feed updates every ~3 s

// ---- live targets and what to do next ------------------------------------------------
let phaseStart = { at: Date.now(), pos: null };
function setPhase(p) {
  if (p === S.phase) return;
  S.phase = p;
  phaseStart = { at: Date.now(), pos: S.flight?.position ? { ...S.flight.position } : null };
}
function updatePhase() {
  const before = S.phase;
  const pos = S.flight?.position;
  const moved = pos && phaseStart.pos ? Math.hypot(pos.x - phaseStart.pos.x, pos.y - phaseStart.pos.y) : 0;
  if (pos && !phaseStart.pos) phaseStart.pos = { ...pos };
  setPhase(nextPhase(S.phase, null, S.flight, S.recent, { moved, secs: (Date.now() - phaseStart.at) / 1000 }));
  // Just landed: jump to the ATC view so the "what now" shows up.
  if (before === "airborne" && S.phase === "landing" && document.body.classList.contains("callsMode")) document.querySelector('#tabs button[data-tab="atc"]').click();
}
let lastLive = "";
function renderLive() {
  const lines = track(targets(S.recent), S.flight);
  const landRwy = [...S.recent].reverse().find((i) => i.type === "land" || i.type === "approach")?.runway || null;
  const lastTaxi = [...S.recent].reverse().find((i) => i.type === "taxi");
  const tip = phaseTip(S.phase, S.flight, { callsign: sayCallsign(), runway: landRwy, gate: lastTaxi?.gate || null, route: lastTaxi?.route || [], freeGate: freeGate() });
  const html = lines.map((l) => `<div class="trk ${l.done ? "ok" : l.kind}">${esc(l.text)}</div>`).join("")
    + (tip ? `<div class="tip"><div class="tt">${esc(tip.title)}${tip.button ? `<button class="tipbtn" data-act="${tip.button}">✓ Called</button>` : ""}</div><div>${esc(tip.text)}</div>${tip.say ? `<div class="ts" title="Click to copy">SAY: ${esc(tip.say)}</div>` : ""}</div>` : "");
  if (html === lastLive) return;
  lastLive = html;
  $("live").innerHTML = html;
  $("live").hidden = !html;
}
$("live").addEventListener("click", (e) => {
  // "✓ Called": you made the call, now wait for ATC's route.
  if (e.target.closest(".tipbtn")) { setPhase("called"); lastLive = ""; renderLive(); return; }
  const ts = e.target.closest(".ts"); if (!ts) return;
  navigator.clipboard.writeText(ts.textContent.replace(/^SAY: /, "")).then(() => { ts.classList.add("copied"); setTimeout(() => ts.classList.remove("copied"), 1200); });
});

// ---- My calls -------------------------------------------------------------------
async function pollPlan() {
  const q = S.flightCs || S.callsign.trim();
  if (!q) return;
  const p = await app.plan(q);
  if (p && (!S.plan || p.departing !== S.plan.departing || p.arriving !== S.plan.arriving || p.filed !== S.plan.filed)) { S.plan = p; showAtcHint(); }
  renderCalls();
}
function showAtcHint() {
  const filed = S.plan?.filed;
  $("atcCsHint").textContent = filed && filed.toLowerCase() !== (S.flightCs || "").toLowerCase() ? `Your flight plan says "${filed}", so that counts too.` : "";
}
async function pollAtis() { const a = await app.atis(); if (Array.isArray(a)) S.atis = a; renderCalls(); }
app.airports().then((a) => { if (a) S.airports = a; renderCalls(); });
pollPlan(); setInterval(pollPlan, 20000);
pollAtis(); setInterval(pollAtis, 30000);

let lastCalls = "";
function renderCalls() {
  const { calls, next, where } = buildCalls({ callsign: sayCallsign(), flight: S.flight, plan: S.plan, atis: S.atis, airports: S.airports, recent: S.recent, freeGate: freeGate() });
  const html = calls.map((c) => `<div class="call${c.id === next ? " next" : ""}" data-id="${c.id}">
      <div class="t">${esc(c.title)}</div>
      <div class="x">${esc(c.text).replace(/\[([^\]]+)\]/g, "<i>[$1]</i>")}</div>
      ${c.hint || c.missing?.length ? `<div class="h">${esc([c.hint, c.missing?.length ? `Missing: ${c.missing.join(", ")}` : ""].filter(Boolean).join(" · "))}</div>` : ""}
    </div>`).join("");
  const w = [where.airport && `At <b>${esc(where.airport)}</b>`, where.atis && `ATIS <b>${esc(where.atis)}</b>`, where.runway && `runway <b>${esc(where.runway)}</b>`, where.dest && `to <b>${esc(where.dest)}</b>`].filter(Boolean).join(" · ");
  const key = html + w;
  if (key === lastCalls) return;
  lastCalls = key;
  $("callList").innerHTML = html;
  $("where").innerHTML = w || "Fly or file a flight plan and the blanks fill in.";
}
$("callList").addEventListener("click", (e) => {
  const card = e.target.closest(".call"); if (!card) return;
  navigator.clipboard.writeText(card.querySelector(".x").textContent).then(() => { card.classList.add("copied"); setTimeout(() => card.classList.remove("copied"), 1200); });
});
document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
  const calls = b.dataset.tab === "calls";
  document.body.classList.toggle("callsMode", calls);
  $("callsView").hidden = !calls;
  localStorage.setItem("tab", b.dataset.tab);
  renderCalls();
}));
if (localStorage.getItem("tab") === "calls") document.querySelector('#tabs button[data-tab="calls"]').click();
window.__calls = { S, renderCalls, renderLive, updatePhase };
if (window.copilot) startAudio(); else { $("heard").textContent = "Browser preview: type a call in ⚙ settings to test."; setDot(); }
window.__test = handle; // for trying calls from the dev console
window.__clip = onClip;
window.__text = (t) => onText(t); // for testing joined-up calls

// ---- the card ages out ------------------------------------------------------------
// Shows how long ago the call was; after 30 s it moves into the list below.
const CARD_MS = 30000;
setInterval(() => {
  const card = $("now");
  if (!card.dataset.payload || !card.dataset.at) { $("age").textContent = ""; return; }
  const age = Date.now() - +card.dataset.at;
  $("age").textContent = age > 4000 ? `${Math.round(age / 1000)} s ago` : "";
  if (age > CARD_MS) {
    addHistory(JSON.parse(card.dataset.payload), true);
    delete card.dataset.payload; delete card.dataset.at;
    card.classList.add("empty");
    $("doList").innerHTML = '<li class="muted">Waiting for ATC…</li>';
    $("say").textContent = "—"; $("say").classList.add("muted");
    $("heard").textContent = ""; $("age").textContent = "";
  }
}, 1000);

// ---- closest empty gate ------------------------------------------------------------
let gateLabels = null;
app.taxiLabels().then((l) => { if (l) gateLabels = l; });
function freeGate() {
  if (!gateLabels || !S.flight || !S.flight.isOnGround) return null;
  const g = closestEmptyGate({ me: S.flight, aircraft: S.all || {}, labels: gateLabels, myCallsign: S.flightCs });
  return g ? g.name : null;
}
