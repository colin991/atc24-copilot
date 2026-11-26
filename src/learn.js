// Learning how speech-to-text mishears YOUR callsign.
//
// When you tap a grey line ("that was for me"), the odd words near the start
// of it ("factage", "bulimia") are remembered; a later call starting with
// one of them counts as yours.
//
//   soundsFrom(heard)            -> the words worth remembering from a call
//   matchesLearned(heard, list)  -> true if the call starts with one of them

// Everyday and radio words never count (they'd match everyone's calls).
const COMMON = new Set((
  "the a an and or but if so to of in on at by for from with as is are was were be been it its this that these those " +
  "you your youre we were our us they them their he she him her i im ive me my mine do does did done have has had " +
  "will would can could should may might must shall not no yes yeah okay ok copy roger wilco affirm affirmative negative " +
  "please thanks thank good day morning evening night again say said tell told just now then there here where when what " +
  "who why how all any some more most less very really well like going gonna want wanna know think see look need go come " +
  "climb climbing descend descending maintain cleared clear runway taxi hold short line up wait takeoff take off land landing " +
  "contact tower ground approach departure center centre delivery radar heading turn left right fly direct proceed via " +
  "expect report squawk speed knots feet flight level traffic wind winds information frequency approved push pushback " +
  "start startup gate stand apron ramp vacate cross continue resume own navigation identified contact monitor " +
  "november alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike oscar papa quebec romeo sierra " +
  "tango uniform victor whiskey xray yankee zulu zero one two three four five six seven eight nine niner ten"
).split(/\s+/));

// Where the instruction starts; the callsign comes before it.
const VERBS = new Set("climb descend maintain taxi hold turn cleared clear contact monitor line squawk expect report cross proceed fly reduce increase vacate continue go push start resume say confirm".split(" "));

export function soundsFrom(heard) {
  const words = String(heard || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean).slice(0, 10);
  const stop = words.findIndex((w) => VERBS.has(w));
  const head = stop >= 0 ? words.slice(0, stop) : words.slice(0, 6);
  return [...new Set(head.filter((w) => w.length >= 4 && !/\d/.test(w) && !COMMON.has(w)))].slice(0, 4);
}

export function matchesLearned(heard, learned = []) {
  if (!learned.length) return false;
  const words = new Set(String(heard || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).slice(0, 10));
  return learned.some((w) => words.has(w));
}
