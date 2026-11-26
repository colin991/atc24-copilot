// Listens to system audio (or a microphone) and cuts out each radio call.
//
// A simple voice detector: it tracks the background noise level (engines,
// wind) and starts a clip when sound rises clearly above it, then ends the
// clip after a short silence. Each clip comes out as 16 kHz mono WAV.
const RATE = 16000;
const FRAME = 512;                 // 32 ms
const PRE_ROLL = 10;               // frames kept from before the start (~0.3 s)
const START_FRAMES = 3;            // ~0.1 s above the noise to start
const END_SILENCE = 34;            // ~1.1 s quiet to end (ATC pauses mid-call)
const MAX_FRAMES = Math.round(25 * RATE / FRAME);
const MIN_FRAMES = 14;             // ignore blips under ~0.45 s

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(${FRAME}); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === ${FRAME}) { this.port.postMessage(this.buf.slice()); this.n = 0; } }
    return true;
  }
}
registerProcessor("tap", Tap);`;

export async function listInputs() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "audioinput").map((d) => ({ id: d.deviceId, label: d.label || "Microphone" }));
  } catch { return []; }
}

export class Listener {
  constructor({ onClip, onLevel, sensitivity = 3 }) {
    this.onClip = onClip; this.onLevel = onLevel; this.sensitivity = sensitivity;
    this.ctx = null; this.stream = null; this.paused = false;
  }

  async start(source = "system") {
    await this.stop();
    if (source === "system") {
      // Electron answers this with the whole system's audio (see main.cjs).
      this.stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 1, height: 1, frameRate: 1 } });
      this.stream.getVideoTracks().forEach((t) => t.stop());
    } else {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: source === "mic" ? undefined : { exact: source }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    }
    if (!this.stream.getAudioTracks().length) throw new Error("No audio in that source");
    this.ctx = new AudioContext({ sampleRate: RATE });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await this.ctx.audioWorklet.addModule(url);
    const src = this.ctx.createMediaStreamSource(new MediaStream(this.stream.getAudioTracks()));
    const tap = new AudioWorkletNode(this.ctx, "tap");
    src.connect(tap);
    // Not connected to the speakers: we only listen.
    this.reset();
    tap.port.onmessage = (e) => this.frame(e.data);
  }

  async stop() {
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { await this.ctx?.close(); } catch {}
    this.ctx = null; this.stream = null;
  }

  reset() { this.floor = 0.003; this.pre = []; this.clip = null; this.loud = 0; this.quiet = 0; }

  frame(f) {
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length);
    // Background noise: falls fast, rises slowly, so speech doesn't drag it up.
    this.floor = rms < this.floor ? this.floor * 0.9 + rms * 0.1 : this.floor * 0.998 + rms * 0.002;
    this.floor = Math.max(this.floor, 0.0005);
    const speech = rms > this.floor * this.sensitivity && rms > 0.004;
    this.onLevel?.(rms, this.floor, speech || !!this.clip);
    if (this.paused) { this.clip = null; return; }

    if (!this.clip) {
      this.pre.push(f); if (this.pre.length > PRE_ROLL) this.pre.shift();
      this.loud = speech ? this.loud + 1 : 0;
      if (this.loud >= START_FRAMES) { this.clip = [...this.pre]; this.quiet = 0; }
      return;
    }
    this.clip.push(f);
    this.quiet = speech ? 0 : this.quiet + 1;
    if (this.quiet >= END_SILENCE || this.clip.length >= MAX_FRAMES) {
      const frames = this.clip; this.clip = null; this.pre = []; this.loud = 0;
      if (frames.length - this.quiet >= MIN_FRAMES) this.onClip(toWav(frames));
    }
  }
}

// Float frames -> 16-bit PCM WAV (ArrayBuffer), lightly normalised.
export function toWav(frames) {
  const n = frames.reduce((s, f) => s + f.length, 0);
  let peak = 0.001;
  for (const f of frames) for (let i = 0; i < f.length; i++) peak = Math.max(peak, Math.abs(f[i]));
  const gain = Math.min(8, 0.9 / peak);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const f of frames) for (let i = 0; i < f.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, f[i] * gain)) * 0x7fff, true);
  return buf;
}

// WAV (from toWav) -> Float32Array for the built-in Whisper.
export function wavToFloat(buf) {
  const v = new DataView(buf), n = (buf.byteLength - 44) / 2, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(44 + i * 2, true) / 0x8000;
  return out;
}
