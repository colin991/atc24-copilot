// "My calls": the pilot's own radio calls, filled in from live data.
//
//   buildCalls({ callsign, flight, plan, atis, airports, recent }) -> {
//     calls: [{ id, title, text, hint, missing }],   in flying order
//     next:  id of the call you most likely make next
//     where: { airport, runway, atis }               what was worked out
//   }
//
// flight   = your aircraft from the radar (heading, altitude, groundSpeed, isOnGround, aircraftType, position)
// plan     = your flight plan ({ departing, arriving, ... }) or null
// atis     = the ATIS list from 24data ([{ airport, letter, content }])
// airports = { ICAO: { x, y } }
// recent   = ATC instructions understood so far this flight (newest last)
import { spokenCallsign } from "./atc.js";

const fmtAlt = (ft) => (ft >= 18000 ? `flight level ${Math.round(ft / 100)}` : `${(Math.round(ft / 100) * 100).toLocaleString("en-US")}`);
const pad3 = (h) => String(((Math.round(h) % 360) + 360) % 360 || 360).padStart(3, "0");
const blank = (what) => `[${what}]`;

function nearestAirport(flight, airports) {
  if (!flight?.position || !airports) return null;
  let best = null;
  for (const [icao, p] of Object.entries(airports)) {
    const d = Math.hypot(p.x - flight.position.x, p.y - flight.position.y);
    if (!best || d < best.d) best = { icao, d };
  }
  return best && best.d < 12000 ? best.icao : null; // ~3.6 NM
}

function atisFor(icao, atis) {
  const a = (atis || []).find((x) => x.airport === icao);
  if (!a) return null;
  const dep = /DEP RWY ([0-9]{1,2}[LRC]?(?:\s*(?:AND|,|\/)\s*[0-9]{1,2}[LRC]?)*)/i.exec(a.content || "");
  const arr = /ARR RWY ([0-9]{1,2}[LRC]?(?:\s*(?:AND|,|\/)\s*[0-9]{1,2}[LRC]?)*)/i.exec(a.content || "");
  const first = (m) => (m ? m[1].split(/\s*(?:AND|,|\/)\s*/i)[0] : null);
  return { letter: a.letter, dep: first(dep), arr: first(arr) };
}

const lastOf = (recent, type) => [...(recent || [])].reverse().find((i) => i.type === type);

export function buildCalls({ callsign = "", flight = null, plan = null, atis = [], airports = null, recent = [], freeGate = null } = {}) {
  const cs = spokenCallsign(callsign) || blank("callsign");
  const onGround = flight ? !!flight.isOnGround : true;
  const here = nearestAirport(flight, airports) || (onGround ? plan?.departing : null);
  const dest = plan?.arriving || null;
  const hereAtis = atisFor(here, atis);
  const destAtis = atisFor(dest, atis);

  // Runways: what ATC said last, else the ATIS.
  const holdShort = lastOf(recent, "holdshort");
  const taxi = lastOf(recent, "taxi");
  const lineup = lastOf(recent, "lineup");
  const depRunway = lineup?.runway || holdShort?.runway || taxi?.runway || hereAtis?.dep || null;
  const arrRunway = lastOf(recent, "approach")?.runway || lastOf(recent, "land")?.runway || destAtis?.arr || (here && !onGround ? hereAtis?.arr : null);
  const taxiway = holdShort?.taxiway || (taxi?.route?.length ? taxi.route[taxi.route.length - 1] : null);

  const fill = (v, what) => (v ? v : blank(what));
  const calls = [
    {
      id: "clearance", title: "IFR clearance",
      text: `${cs} requesting IFR clearance to ${fill(dest, "airport")} information ${fill(hereAtis?.letter, "ATIS")} on board.`,
      missing: [!dest && "airport (file a flight plan)", !hereAtis && "ATIS letter"].filter(Boolean),
    },
    { id: "pushstart", title: "Push and start", text: `${cs} requesting push and start.` },
    { id: "taxi", title: "Taxi", text: `${cs} requesting taxi pattern.`, hint: "Remember the letters for the taxiways." },
    {
      id: "holdshort", title: "Holding short",
      text: `${cs} holding short ${fill(taxiway, "taxiway")} at runway ${fill(depRunway, "#")}.`,
      missing: [!taxiway && "taxiway", !depRunway && "runway"].filter(Boolean),
    },
    {
      id: "lineup", title: "Line up and wait",
      text: `${cs} line up and wait runway ${fill(depRunway, "#")}.`, hint: "Wait for clearance to depart.",
      missing: [!depRunway && "runway"].filter(Boolean),
    },
    {
      id: "airspace", title: "Entering airspace",
      text: flight
        ? `${cs} gonna be with you maintaining heading ${pad3(flight.heading)} at ${fmtAlt(flight.altitude)} and ${Math.round(flight.groundSpeed || 0)} knots, aircraft type ${flight.aircraftType || blank("aircraft")}.`
        : `${cs} gonna be with you maintaining ${blank("heading")} at ${blank("altitude")} and ${blank("speed")} knots, aircraft type ${blank("aircraft")}.`,
      missing: [!flight && "your flight (not on the radar)"].filter(Boolean),
    },
    {
      id: "final", title: "Final approach",
      text: `Tower, ${cs} visual runway ${fill(arrRunway, "#")}.`,
      missing: [!arrRunway && "runway"].filter(Boolean),
    },
    { id: "gate", title: "Taxi to gate", text: `${cs} requesting taxi pattern to ${freeGate ? `gate ${freeGate}` : "gate"}.`, hint: freeGate ? `Gate ${freeGate} is the closest empty one.` : "Only if needed." },
  ];

  // Which call is next? Go by what ATC last told you and where you are.
  const lastType = (recent || []).length ? recent[recent.length - 1].type : null;
  let next = "clearance";
  if (!onGround) {
    const alt = flight?.altitude || 0;
    next = lastType === "contact" ? "airspace" : lastType === "approach" || lastType === "land" || (alt < 3000 && dest && here === dest) ? "final" : "airspace";
  } else if (lastType === "land" || lastOf(recent, "land")) next = "gate";
  else if (lastType === "lineup") next = "lineup";
  else if (lastType === "holdshort" || (lastType === "taxi" && holdShort)) next = "holdshort";
  else if (lastType === "pushback" || lastType === "startup") next = "taxi";
  else if (lastOf(recent, "clearance") || lastType === "squawk") next = "pushstart";
  if (lastType === "taxi" && !holdShort) next = "holdshort";

  return { calls, next, where: { airport: here, runway: depRunway, atis: hereAtis?.letter || null, dest } };
}
