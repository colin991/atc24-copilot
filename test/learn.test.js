import assert from "node:assert/strict";
import test from "node:test";
import { soundsFrom, matchesLearned } from "../src/learn.js";

test("remembers the odd words of a misheard callsign, not radio words", () => {
  assert.deepEqual(soundsFrom("copy , november factage by bulimia taxi holding point a4 via a kilo alpha"), ["factage", "bulimia"]);
  assert.deepEqual(soundsFrom("descend and maintain 2000"), []);
});

test("a later call starting with a learned word counts", () => {
  const learned = soundsFrom("november factage by bulimia, descend and maintain 2000");
  assert.equal(matchesLearned("factage bulimia climb and maintain 4000", learned), true);
  assert.equal(matchesLearned("shamrock 4512 climb and maintain 4000", learned), false);
});
