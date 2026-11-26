import assert from "node:assert/strict";
import test from "node:test";
import { closestEmptyGate } from "../src/gates.js";

const labels = { IRFD: { labels: [[0, 0, 0, "1"], [100, 0, 0, "2"], [300, 0, 0, "3"], [50, 50, 0, "A"]] } };

test("picks the nearest gate nobody is parked at", () => {
  const me = { position: { x: 90, y: 200 } };
  // Gate 2 is nearest but taken; gate 1 next; gate 3 further.
  const aircraft = { "Shamrock-1": { position: { x: 105, y: 10 }, isOnGround: true, groundSpeed: 0 } };
  assert.equal(closestEmptyGate({ me, aircraft, labels }).name, "1");
});

test("a plane taxiing past doesn't take a gate, and taxiway letters aren't gates", () => {
  const me = { position: { x: 100, y: 150 } };
  const aircraft = { "Taxiing-2": { position: { x: 100, y: 0 }, isOnGround: true, groundSpeed: 15 } };
  assert.equal(closestEmptyGate({ me, aircraft, labels }).name, "2");
});

test("no gates near you -> null", () => {
  assert.equal(closestEmptyGate({ me: { position: { x: 90000, y: 0 } }, labels }), null);
});
