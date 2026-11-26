// Live guidance: what ATC asked for vs what your plane is doing right now,
// and what to do next on the ground (after landing especially).
//
//   targets(recent)                      -> { heading, altitude, speed } ATC last gave you
//   track(targets, flight)               -> [{ kind, text, todo, done }] one line each
//   phaseTip(phase, flight, ctx)         -> { title, text, say } or null
//   nextPhase(phase, prev, flight, recent) -> the flight phase after this radar update
//
// flight = your aircraft from the radar: heading, altitude, speed (airspeed),
// groundSpeed, isOnGround. Airspeed is what ATC speed instructions mean.
import { spokenCallsign } from "./atc.js";

const pad3 = (h) => String(((Math.round(h) % 360) + 360) % 360 || 360).padStart(3, "0");
const ft = (n) => `${(Math.round(n / 10) * 10).toLocaleString("en-US")}`;

export function targets(recent = []) {
  const t = { heading: null, altitude: null, speed: null };
  for (const i of recent) {
    if (i.type === "heading" && i.heading != null) t.heading = { value: i.heading, dir: i.dir || null };
    if (i.type === "altitude" && i.ft != null) t.altitude = { value: i.ft };
    if (i.type === "speed") t.speed = i.kt != null ? { value: i.kt } : null; // "resume normal speed" clears it
    // A new phase of flight makes old vectors stale.
    if (["takeoff", "land", "goaround", "ownnav", "approach", "clearance"].includes(i.type)) { t.heading = null; if (i.type !== "approach") t.speed = null; }
    if (i.type === "land" || i.type === "clearance") t.altitude = null;
  }
  return t;
}

// Signed turn from `from` to `to`, in the direction ATC said (or the short way).
function turnLeft(from, to, dir) {
  const right = ((to - from) % 360 + 360) % 360; // degrees turning right
  if (dir === "right") return { dir: "right", deg: right };
  if (dir === "left") return { dir: "left", deg: (360 - right) % 360 };
  return right <= 180 ? { dir: "right", deg: right } : { dir: "left", deg: 360 - right };
}

export function track(t, flight) {
  if (!flight) return [];
  const out = [];
  if (t.heading && !flight.isOnGround) {
    const { dir, deg } = turnLeft(flight.heading, t.heading.value, t.heading.dir);
    const done = deg <= 5 || deg >= 355;
    out.push({ kind: "heading", done, todo: done ? 0 : deg,
      text: done ? `Heading ${pad3(t.heading.value)} ✓` : `TURN ${dir.toUpperCase()} ${pad3(flight.heading)} → ${pad3(t.heading.value)} · ${Math.round(deg)}° to go` });
  }
  if (t.altitude && !flight.isOnGround) {
    const diff = t.altitude.value - flight.altitude;
    const done = Math.abs(diff) <= 150;
    out.push({ kind: "altitude", done, todo: Math.abs(diff),
      text: done ? `Altitude ${ft(t.altitude.value)} ft ✓` : `${diff > 0 ? "CLIMB" : "DESCEND"} ${ft(flight.altitude)} → ${ft(t.altitude.value)} ft · ${ft(Math.abs(diff))} to go` });
  }
  const spd = flight.speed ?? flight.groundSpeed;
  if (t.speed && spd != null && !flight.isOnGround) {
    const diff = t.speed.value - spd;
    const done = Math.abs(diff) <= 10;
    out.push({ kind: "speed", done, todo: Math.abs(diff),
      text: done ? `Speed ${t.speed.value} kt ✓` : `${diff > 0 ? "SPEED UP" : "SLOW DOWN"} ${Math.round(spd)} → ${t.speed.value} kt · ${Math.round(Math.abs(diff))} to go` });
  }
  return out;
}

// ---- flight phases --------------------------------------------------------------
// parked -> taxiing -> airborne -> landing (rolling out) -> vacated -> taxiing in -> parked
export function nextPhase(phase, prev, flight, recent = []) {
  if (!flight) return phase || "unknown";
  const gs = flight.groundSpeed || 0;
  if (!flight.isOnGround) return "airborne";
  if (phase === "airborne") return "landing";                       // just touched down
  if (phase === "landing") return gs < 35 ? "vacate" : "landing";   // slowed right down
  if (phase === "vacate") {
    if (recent.length && recent[recent.length - 1].type === "taxi") return "taxiin";
    return gs > 3 && gs < 35 ? "vacate" : gs <= 3 ? "stopped" : "vacate";
  }
  if (phase === "stopped") return recent.length && recent[recent.length - 1].type === "taxi" ? "taxiin" : gs > 3 ? "vacate" : "stopped";
  if (phase === "taxiin") return gs <= 1 ? "parkedin" : "taxiin";
  if (phase === "parkedin") return gs > 3 ? "taxiin" : "parkedin";
  return gs > 2 ? "taxiing" : "parked";
}

export function phaseTip(phase, flight, { callsign = "", runway = null, gate = null, route = [], freeGate = null } = {}) {
  // The gate to ask for: the closest empty one, if we know it.
  const askGate = freeGate ? `gate ${freeGate}` : "gate";
  const freeNote = freeGate ? ` Closest empty gate: ${freeGate}.` : "";
  const cs = spokenCallsign(callsign) || "[callsign]";
  const rwy = runway ? `runway ${runway}` : "the runway";
  switch (phase) {
    case "landing":
      return { title: "Landed", text: `Brake and slow to taxi speed. Turn off ${rwy} at the next exit; don't stop on it.` };
    case "vacate":
      return { title: "Clear the runway", text: `Keep going until you're past the yellow hold-short line, then STOP and call for taxi.${freeNote}`, say: `${cs} clear of ${rwy}, requesting taxi pattern to ${askGate}.` };
    case "stopped":
      return { title: "Request taxi", text: `You're stopped. Ask ATC for taxi to the gate, then wait for the route.${freeNote}`, say: `${cs} requesting taxi pattern to ${askGate}.` };
    case "taxiin":
      return {
        title: gate ? `Taxi to ${gate}` : "Taxi to the gate",
        text: `${route.length ? `Route: ${route.join(" → ")}. ` : ""}${gate ? `Go to ${gate.toUpperCase().replace(/^(GATE|STAND|SPOT|PARKING)/, (w) => w.charAt(0) + w.slice(1).toLowerCase())}` : "Follow the taxiways ATC gave you"}, under 20 knots, and stop there.`,
      };
    case "parkedin":
      return { title: gate ? `At ${gate}` : "At the gate", text: "You're parked. Engines off. Nice flight!" };
    default:
      return null;
  }
}
