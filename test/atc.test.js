import assert from "node:assert/strict";
import test from "node:test";
import { understand, spokenCallsign } from "../src/atc.js";
import { normalize } from "../src/words.js";

const me = { callsign: "Speedbird-208" };
const types = (r) => r.items.map((i) => i.type);

test("spoken numbers become digits", () => {
  assert.equal(normalize("turn left heading two seven zero"), "turn left heading 270");
  assert.equal(normalize("climb and maintain five thousand"), "climb and maintain 5000");
  assert.equal(normalize("one thousand five hundred feet"), "1500 feet");
  assert.equal(normalize("contact approach one two zero decimal two five"), "contact approach 120.25");
  assert.equal(normalize("descend flight level one two zero"), "descend fl120");
  assert.equal(normalize("runway two five left cleared for takeoff"), "runway 25L cleared for takeoff");
  assert.equal(normalize("climb to 5,000 feet"), "climb to 5000 feet");
});

test("callsign readback style", () => {
  assert.equal(spokenCallsign("Speedbird-208"), "Speedbird 208");
});

test("heading and altitude, with your flight for direction", () => {
  const r = understand("Speedbird two zero eight, turn left heading two seven zero, climb and maintain five thousand", { ...me, flight: { heading: 310, altitude: 2100 } });
  assert.equal(r.forMe, true);
  assert.deepEqual(types(r), ["heading", "altitude"]);
  assert.match(r.items[0].do, /Turn LEFT to heading 270 \(now 310\)/);
  assert.match(r.items[1].do, /Climb to 5,000 ft \(now 2100 ft\)/);
  assert.equal(r.readback, "Left heading 270, climb and maintain 5000, Speedbird 208");
});

test("works out the turn direction when ATC doesn't say it", () => {
  const r = understand("Speedbird 208 fly heading 090", { ...me, flight: { heading: 350 } });
  assert.equal(r.items[0].dir, "right");
  assert.equal(r.readback, "Fly heading 090, Speedbird 208");
});

test("calls for someone else are flagged", () => {
  const r = understand("Shamrock 4512, descend and maintain 3000", me);
  assert.equal(r.forMe, false);
});

test("takeoff, landing and line up", () => {
  assert.equal(understand("Speedbird 208, runway 25 left, cleared for takeoff", me).readback, "Cleared for takeoff runway 25L, Speedbird 208");
  assert.equal(understand("Speedbird 208 runway 07 cleared to land", me).readback, "Cleared to land runway 07, Speedbird 208");
  assert.deepEqual(types(understand("Speedbird 208 line up and wait runway 25L", me)), ["lineup"]);
});

test("frequency changes", () => {
  const r = understand("Speedbird 208, contact Rockford Approach on 120.25, good day", me);
  assert.equal(r.items[0].type, "contact");
  assert.equal(r.readback, "Rockford Approach 120.25, Speedbird 208");
});

test("taxi with a route and hold short", () => {
  const r = understand("Speedbird 208 taxi to runway 25L via alpha, bravo two, hold short runway 25L", me);
  assert.deepEqual(types(r), ["taxi", "holdshort"]);
  assert.deepEqual(r.items[0].route, ["A", "B2"]);
  assert.equal(r.readback, "Taxi to runway 25L via A, B2, hold short runway 25L, Speedbird 208");
});

test("IFR clearance is read back in one go", () => {
  const r = understand("Speedbird 208, cleared to IRFD via the GRASS1C departure, runway 25, initial climb 3000, squawk 4521", me);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].type, "clearance");
  assert.match(r.readback, /^Cleared to IRFD, GRASS1C departure, .*runway 25, climb 3000, squawk 4521, Speedbird 208$/);
});

test("squawk, speed, direct, flight levels", () => {
  assert.equal(understand("Speedbird 208 squawk 7421", me).readback, "Squawk 7421, Speedbird 208");
  assert.equal(understand("Speedbird 208 reduce speed 180 knots", me).readback, "Speed 180, Speedbird 208");
  assert.equal(understand("Speedbird 208 proceed direct GRASS", me).readback, "Direct GRASS, Speedbird 208");
  assert.equal(understand("Speedbird 208 climb flight level one two zero", me).readback, "Climb and maintain flight level 120, Speedbird 208");
});

test("say altitude answers from your flight", () => {
  const r = understand("Speedbird 208 say altitude", { ...me, flight: { altitude: 4980 } });
  assert.equal(r.readback, "5000 feet, Speedbird 208");
});

test("radar contact only needs a roger", () => {
  assert.equal(understand("Speedbird 208 radar contact", me).readback, "Roger, Speedbird 208");
});

test("approach clearance and go around", () => {
  assert.equal(understand("Speedbird 208, cleared ILS approach runway 25L", me).readback, "Cleared ILS approach runway 25L, Speedbird 208");
  assert.equal(understand("Speedbird 208 go around", me).readback, "Going around, Speedbird 208");
});

test("nothing recognised falls through to the model", () => {
  assert.equal(understand("Speedbird 208 the weather is lovely today", me).unknown, true);
});

test("taxiways with numbers stay whole (K5, not K)", () => {
  assert.equal(understand("Speedbird 208 hold short of kilo five", me).readback, "Hold short K5, Speedbird 208");
  assert.equal(understand("Speedbird 208 taxi via Kay five", me).readback, "Taxi via K5, Speedbird 208");
  assert.equal(understand("Speedbird 208 hold short runway 25 at kilo 5", me).readback, "Hold short runway 25 at K5, Speedbird 208");
  assert.equal(understand("Speedbird 208 cross runway 25 at K5", me).readback, "Cross runway 25 at K5, Speedbird 208");
  assert.equal(understand("Speedbird 208 taxi to runway 07 via alpha two, kilo five, hold short runway 07", me).readback, "Taxi to runway 07 via A2, K5, hold short runway 07, Speedbird 208");
});

test("no callsign heard is never treated as for me", () => {
  const r = understand("if we're going to maintain 500", { callsign: "Jetbloo-3032" });
  assert.equal(r.forMe, null);
  const other = understand("Shamrock 4512, descend and maintain 3000", { callsign: "Jetbloo-3032" });
  assert.equal(other.forMe, false);
  assert.equal(other.to, "Shamrock 4512");
});

test("a callsign number split up by speech-to-text still counts", () => {
  assert.equal(understand("jet blue 30 32, climb and maintain 5000", { callsign: "Jetbloo-3032" }).forMe, true);
});

test("the callsign ATC uses from your flight plan (JetBlue 29W) counts as you", () => {
  const r = understand("copy, jipblue29 whiskey, turn right heading 360, climate maintain 030", { callsign: "JetBloo-3032", aliases: ["JetBlue 29W"] });
  assert.equal(r.forMe, true);
  assert.equal(r.readback, "Right heading 360, climb and maintain 3000, Jetblue 29 Whiskey");
  // Another pilot's 29 without your letter isn't you.
  assert.notEqual(understand("Shamrock 29, climb and maintain 5000", { callsign: "JetBloo-3032", aliases: ["JetBlue 29W"] }).forMe, true);
});

test("your calls: clearance as filed, squawk code, hold at B2, runway 03 1", () => {
  const me = { callsign: "JetBloo-3032", aliases: ["JetBlue 29W"] };
  assert.equal(understand("jetblue 29 whiskey, you are clear to per international airport as filed expect 1000 , and then the departure will be 123.3 and expect the squawk code 6741", me).readback,
    "Cleared to IPPH as filed, expect 1000, departure 123.3, squawk 6741, Jetblue 29 Whiskey");
  assert.equal(understand("jetblue 29 whiskey, you are clear to taxi to runway 03 1 via a2 , whole drop , bravo 2", me).readback, "Taxi to runway 31 via A2, hold short B2, Jetblue 29 Whiskey");
  assert.equal(understand("jetblue 29 whiskey taxi to runway 25 via alpha, hold at bravo 2", me).readback, "Taxi to runway 25 via A, hold short B2, Jetblue 29 Whiskey");
  assert.equal(understand("jetblue 29 whiskey good day, you can tax you to gate 1 0 via alpha", me).readback, "Taxi to gate 10 via A, Jetblue 29 Whiskey");
  // "expect" with nothing to plan for is not an instruction.
  assert.equal(understand("jetblue 29 whiskey expect im unfortunately busy", me).unknown, true);
});
