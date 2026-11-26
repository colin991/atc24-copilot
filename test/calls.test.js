import assert from "node:assert/strict";
import test from "node:test";
import { buildCalls } from "../src/calls.js";

const airports = { IRFD: { x: -3000, y: 20800 }, ITKO: { x: -8000, y: -32000 } };
const atis = [{ airport: "IRFD", letter: "C", content: "IRFD ATIS INFO C\nDEP RWY 25L ARR RWY 25R\n..." }];
const parked = { heading: 250, altitude: 40, groundSpeed: 0, isOnGround: true, aircraftType: "A320", position: { x: -3050, y: 20850 } };
const byId = (r, id) => r.calls.find((c) => c.id === id);

test("IFR clearance uses the flight plan and this airport's ATIS", () => {
  const r = buildCalls({ callsign: "Speedbird-208", flight: parked, plan: { departing: "IRFD", arriving: "ITKO" }, atis, airports });
  assert.equal(byId(r, "clearance").text, "Speedbird 208 requesting IFR clearance to ITKO information C on board.");
  assert.equal(r.next, "clearance");
  assert.equal(byId(r, "lineup").text, "Speedbird 208 line up and wait runway 25L.");
});

test("holding short uses the taxiway and runway ATC gave", () => {
  const recent = [{ type: "clearance" }, { type: "pushback" }, { type: "taxi", runway: "25L", route: ["A", "K5"] }, { type: "holdshort", runway: "25L", taxiway: "K5" }];
  const r = buildCalls({ callsign: "Speedbird-208", flight: parked, atis, airports, recent });
  assert.equal(byId(r, "holdshort").text, "Speedbird 208 holding short K5 at runway 25L.");
  assert.equal(r.next, "holdshort");
});

test("entering airspace reads your heading, altitude, speed and type", () => {
  const r = buildCalls({ callsign: "Speedbird-208", flight: { heading: 90, altitude: 5020, groundSpeed: 251, isOnGround: false, aircraftType: "A320", position: { x: 0, y: 0 } }, airports, recent: [{ type: "contact" }] });
  assert.equal(byId(r, "airspace").text, "Speedbird 208 gonna be with you maintaining heading 090 at 5,000 and 251 knots, aircraft type A320.");
  assert.equal(r.next, "airspace");
});

test("missing values show as blanks to fill", () => {
  const r = buildCalls({ callsign: "Speedbird-208" });
  assert.match(byId(r, "clearance").text, /\[airport\].*\[ATIS\]/);
  assert.equal(byId(r, "final").text, "Tower, Speedbird 208 visual runway [#].");
});
