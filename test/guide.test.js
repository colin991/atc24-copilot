import assert from "node:assert/strict";
import test from "node:test";
import { targets, track, nextPhase, phaseTip } from "../src/guide.js";

const air = (o) => ({ heading: 20, altitude: 3000, speed: 250, groundSpeed: 240, isOnGround: false, ...o });

test("tracks a speed ATC gave: slow down 250 -> 130", () => {
  const t = targets([{ type: "speed", kt: 130 }]);
  const [line] = track(t, air({ speed: 250 }));
  assert.equal(line.text, "SLOW DOWN 250 → 130 kt · 120 to go");
  assert.equal(track(t, air({ speed: 133 }))[0].text, "Speed 130 kt ✓");
});

test("turns the way ATC said, with degrees to go", () => {
  const t = targets([{ type: "heading", heading: 60, dir: "right" }]);
  assert.equal(track(t, air({ heading: 20 }))[0].text, "TURN RIGHT 020 → 060 · 40° to go");
  // Told to turn left the long way round: still left.
  const l = targets([{ type: "heading", heading: 60, dir: "left" }]);
  assert.equal(track(l, air({ heading: 20 }))[0].text, "TURN LEFT 020 → 060 · 320° to go");
  assert.equal(track(t, air({ heading: 58 }))[0].text, "Heading 060 ✓");
});

test("climb / descend to the altitude ATC gave", () => {
  const t = targets([{ type: "altitude", ft: 5000 }]);
  assert.equal(track(t, air({ altitude: 2100 }))[0].text, "CLIMB 2,100 → 5,000 ft · 2,900 to go");
});

test("landing walks you through vacating and asking for taxi", () => {
  let p = "airborne";
  p = nextPhase(p, null, air({ isOnGround: true, groundSpeed: 120 }));
  assert.equal(p, "landing");
  p = nextPhase(p, null, air({ isOnGround: true, groundSpeed: 25 }));
  assert.equal(p, "vacate");
  const tip = phaseTip(p, null, { callsign: "JetBlue 29W", runway: "25" });
  assert.equal(tip.say, "Jetblue 29 Whiskey clear of runway 25, requesting taxi pattern to gate.");
  p = nextPhase(p, null, air({ isOnGround: true, groundSpeed: 0 }));
  assert.equal(p, "stopped");
  p = nextPhase(p, null, air({ isOnGround: true, groundSpeed: 0 }), [{ type: "taxi" }]);
  assert.equal(p, "taxiin");
});
