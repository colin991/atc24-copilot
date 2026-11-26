// The overlay: hears a call -> text -> what to do + what to say back.
import { understand, spokenCallsign } from "../src/atc.js";
import { Listener, listInputs, wavToFloat } from "./audio.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// In a normal browser (for testing the page) there's no app around it.
const app = window.copilot || {
  aircraft: async () => null, sttStatus: async () => ({ fast: false }), transcribe: async () => ({ error: "browser" }),
  version: async () => "dev", setClickThrough() {}, minimize() {}, quit() {}, installUpdate() {}, on() {},
};

// ---- settings ---------------------------------------------------------------
const S = {
  callsign: localStorage.getItem("callsign") || "",
  server: localStorage.getItem("server") || "main",
  source: localStorage.getItem("source") || "system",
  sens: +(localStorage.getItem("sens") || 3),
  onlyMe: localStorage.getItem("onlyMe") === "1",
  opacity: +(localStorage.getItem("opacity") || 0.82),
  listening: true,
  flight: null,      // your aircraft from the radar
  flightCs: "",      // its callsign, e.g. "Speedbird-208"
  fast: false,       // online speech-to-text available
};
const save = (k, v) => { S[k] = v; localStorage.setItem(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v)); };

// ---- your flight, from the radar ---------------------------------------------
async function pollFlight() {
  const q = S.callsign.trim().toLowerCase();
  if (q) {
    const all = await app.aircraft(S.server);
    if (all) {
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
  else $("flight").innerHTML = `<b>${esc(S.flightCs)}</b> · ${esc(f.aircraftType || "")} · ${f.isOnGround ? "on ground" : `${Math.round(f.altitude).toLocaleString()} ft`} · HDG ${String(Math.round(f.heading)).padStart(3, "0")} · ${Math.round(f.groundSpeed || 0)} kt`;
}
const myCallsign = () => S.flightCs || S.callsign;

// ---- speech to text ------------------------------------------------------------
let worker = null, workerReady = false, nextId = 1;
const pending = new Map();
function localWhisper(wav) {
  if (!worker) {
    worker = new Worker(new URL("./whisper-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.status === "loading") setStt("built-in (downloading model, one time)…");
      if (m.status === "ready") { workerReady = true; setStt("built-in (on this PC)"); }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
  }
  const id = nextId++;
  return new Promise((resolve) => { pending.set(id, resolve); worker.postMessage({ id, audio: wavToFloat(wav) }); });
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
    handle(r.text);
  } finally { busy--; setDot(); }
}

function handle(text) {
  const r = understand(text, { callsign: myCallsign(), flight: S.flight });
  if (r.forMe === false && S.onlyMe) { addHistory(r, false); return; }
  if (r.unknown && r.forMe !== true) { addHistory(r, false); return; } // chatter, not an instruction
  showNow(r);
}

function showNow(r) {
  const card = $("now");
  // Move the current one into history first.
  if (card.dataset.payload) addHistory(JSON.parse(card.dataset.payload), true);
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
app.on("update-ready", (v) => { $("update").hidden = false; $("update").firstChild.textContent = `Update ${v} ready · `; });

// ---- start -----------------------------------------------------------------------
bindSettings();
app.version().then((v) => ($("ver").textContent = v));
app.sttStatus().then((s) => { S.fast = !!s.fast; setStt(S.fast ? "fast (online)" : "built-in (on this PC)"); });
pollFlight();
setInterval(pollFlight, 3000); // the radar's feed updates every ~3 s
if (window.copilot) startAudio(); else { $("heard").textContent = "Browser preview: type a call in ⚙ settings to test."; setDot(); }
window.__test = handle; // for trying calls from the dev console
window.__clip = onClip;
