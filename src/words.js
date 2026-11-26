// Turns a radio transcript into plain, predictable text before parsing:
// spoken numbers become digits ("two seven zero" -> "270", "five thousand"
// -> "5000", "one two zero decimal two five" -> "120.25"), runway sides are
// joined ("two five left" -> "25L"), and filler is dropped.

const DIGITS = {
  zero: 0, oh: 0, one: 1, won: 1, two: 2, to: null, too: 2, three: 3, tree: 3, four: 4, fower: 4, for: null,
  five: 5, fife: 5, six: 6, seven: 7, eight: 8, ait: 8, nine: 9, niner: 9,
};
const TEENS = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

// "to"/"for" are only digits inside a run of other digits ("two to zero" is
// rare; "turn left heading two seven zero, climb to five thousand" is common).
const isDigitWord = (w) => DIGITS[w] !== undefined && DIGITS[w] !== null;

export function normalize(raw) {
  let s = ` ${String(raw || "").toLowerCase()} `;
  s = s
    .replace(/[’']/g, "")
    .replace(/(\d),(\d{3})/g, "$1$2")          // 5,000 -> 5000
    .replace(/(\d)\s*(?:k|thousand)\b/g, "$1 thousand")
    .replace(/\bflight\s*level\b|\bfl(?=\s*\d)/g, " fl ")
    .replace(/\bfl\s+(\d)/g, "fl $1")
    .replace(/[,;]/g, " , ")
    .replace(/[^a-z0-9.,\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\.(?!\d)/g, " , ")
    // Words glued to numbers by speech-to-text: "jipblue29" -> "jipblue 29"
    .replace(/\b([a-z]{3,})(\d{2,4})\b/g, "$1 $2")
    .replace(/\s+/g, " ");
  // Common mishearings of radio words.
  for (const [wrong, right] of MISHEARD) s = s.replace(wrong, right);
  const words = s.trim().split(" ");
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // A run of spoken digits: "two seven zero" -> 270
    if (isDigitWord(w)) {
      let digits = "";
      let j = i;
      while (j < words.length && (isDigitWord(words[j]) || /^\d$/.test(words[j]))) { digits += isDigitWord(words[j]) ? DIGITS[words[j]] : words[j]; j++; }
      // "one thousand five hundred", "three thousand"
      let value = null;
      if (digits.length === 1 && (words[j] === "thousand" || words[j] === "hundred")) {
        value = 0; let k = i;
        while (k < words.length) {
          const d = isDigitWord(words[k]) ? DIGITS[words[k]] : /^\d+$/.test(words[k]) ? +words[k] : null;
          if (d === null) break;
          if (words[k + 1] === "thousand") { value += d * 1000; k += 2; }
          else if (words[k + 1] === "hundred") { value += d * 100; k += 2; }
          else break;
        }
        out.push(String(value)); i = k - 1; continue;
      }
      out.push(digits); i = j - 1; continue;
    }
    if (/^\d+$/.test(w) && (words[i + 1] === "thousand" || words[i + 1] === "hundred")) {
      let value = 0, k = i;
      while (k < words.length) {
        const d = /^\d+$/.test(words[k]) ? +words[k] : isDigitWord(words[k]) ? DIGITS[words[k]] : null;
        if (d === null) break;
        if (words[k + 1] === "thousand") { value += d * 1000; k += 2; }
        else if (words[k + 1] === "hundred") { value += d * 100; k += 2; }
        else { value += d; k += 1; break; }
      }
      out.push(String(value)); i = k - 1; continue;
    }
    if (TEENS[w] !== undefined) { out.push(String(TEENS[w])); continue; }
    if (TENS[w] !== undefined) {
      const n = DIGITS[words[i + 1]];
      if (n) { out.push(String(TENS[w] + n)); i++; } else out.push(String(TENS[w]));
      continue;
    }
    out.push(w);
  }
  let t = ` ${out.join(" ")} `;
  // Join digit groups split by spaces where they clearly belong together.
  t = t
    .replace(/\b(\d+)\s+(?:decimal|point|dot)\s+(\d+)\b/g, "$1.$2")   // 120 decimal 25
    .replace(/\bfl\s+(\d{2,3})\b/g, "fl$1")
    .replace(/\brunway\s+(\d{1,2})\s*(left|right|center|centre|l|r|c)\b/g, (m, n, side) => `runway ${n.padStart(2, "0")}${side[0].toUpperCase()}`)
    .replace(/\brunway\s+(\d)\b(?![\d.])/g, "runway 0$1")
    .replace(/\b(\d{1,2})\s*(left|right|center|centre)\b(?=\s*(?:cleared|via|$|,))/g, (m, n, side) => `${n.padStart(2, "0")}${side[0].toUpperCase()}`)
    .replace(/\s+/g, " ");
  t = joinTaxiways(t);
  return t.replace(/(\s*,\s*)+$/, "").trim();
}

// What speech-to-text writes instead of radio words.
const MISHEARD = [
  [/\bclimate\b/g, "climb and"],
  [/\bclimb in maintain\b/g, "climb and maintain"],
  [/\bdecent\b/g, "descend"],
  [/\bdescent and\b/g, "descend and"],
  [/\bsquak\b|\bsquock\b|\bsquad\b(?= \d)/g, "squawk"],
  [/\bhold\s+shorts?\b/g, "hold short"],
  [/\bline up in wait\b|\bline up and weight\b/g, "line up and wait"],
  [/\bclear(?:ed)? for take ?off\b/g, "cleared for takeoff"],
  [/\bheading\s+(\d)\s+(\d)\s+(\d)\b/g, "heading $1$2$3"],
];

// Letter names as speech-to-text writes them ("kay five" = K5).
const LETTER_NAMES = {
  ay: "a", bee: "b", be: "b", see: "c", sea: "c", cee: "c", dee: "d", ee: "e", eff: "f", gee: "g", aitch: "h",
  jay: "j", kay: "k", okay: "k", el: "l", em: "m", en: "n", pee: "p", cue: "q", queue: "q", tee: "t", tea: "t",
  vee: "v", zee: "z", zed: "z",
};

// "kilo 5", "kay 5", "k 5" -> "k5": one taxiway name, so every rule sees it.
// Not where the callsign goes (start of the call or of a clause), so
// "Delta 12, ..." stays a callsign.
function joinTaxiways(t) {
  const names = [...Object.keys(PHONETIC), ...Object.keys(LETTER_NAMES), "[a-z]"].join("|");
  return t.replace(new RegExp(`\\b(${names})\\s+(\\d{1,2})\\b(?![\\d.]| ?(?:thousand|hundred|knots|feet))`, "g"), (m, word, num, offset, all) => {
    const before = all.slice(0, offset).trim();
    if (!before || before.endsWith(",")) return m; // callsign position
    if (/\b(?:runway|heading|squawk|fl|speed|level|climb|descend|maintain)$/.test(before)) return m;
    const letter = PHONETIC[word] ? PHONETIC[word].toLowerCase() : LETTER_NAMES[word] || word;
    return `${letter}${num}`;
  });
}

// Words used for letters on the radio (taxiways, waypoints).
export const PHONETIC = {
  alpha: "A", alfa: "A", bravo: "B", charlie: "C", delta: "D", echo: "E", foxtrot: "F", golf: "G", hotel: "H",
  india: "I", juliet: "J", juliett: "J", kilo: "K", lima: "L", mike: "M", november: "N", oscar: "O", papa: "P",
  quebec: "Q", romeo: "R", sierra: "S", tango: "T", uniform: "U", victor: "V", whiskey: "W", whisky: "W",
  xray: "X", yankee: "Y", zulu: "Z",
};
