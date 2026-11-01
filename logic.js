// pure hand and music maths, no browser needed (tested by test/logic.test.mjs)

const FINGERS = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]]; // knuckle, middle joint, tip
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SCALE = [0, 2, 4, 7, 9]; // pentatonic, so any two notes sound fine together
const LOW = 45, HIGH = 76;     // A2 to E5

// curled below 70% of the relaxed hand, and open again at 77%; the gap stops it flickering
const CURL_ON = 0.70, CURL_OFF = 0.77;
const NOT_CALIBRATED = [1, 1, 1, 1, 1];
const LOOKS_OPEN = 0.45;     // a finger below this during calibration isn't relaxed, it's curled
const LOWEST_RELAXED = 0.3;  // keeps percentages sane if the thumb rests right against the palm

function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: (a.z || 0) - (b.z || 0) }; }
function len(v) { return Math.hypot(v.x, v.y, v.z); }

export function jointAngle(a, b, c) {
  const u = sub(a, b), v = sub(c, b);
  const cos = (u.x * v.x + u.y * v.y + u.z * v.z) / (len(u) * len(v) || 1);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
}

export function curlMetrics(hand) {
  const angles = FINGERS.map(([k, m, t]) => jointAngle(hand[k], hand[m], hand[t]));
  const thumb = len(sub(hand[4], hand[9])) / (len(sub(hand[9], hand[0])) || 1);
  return { angles, thumb };
}

// how open each finger is before calibration, thumb first; 0 is fully closed
export function rawOpen({ angles, thumb }) {
  return [Math.max(0, (thumb - 0.35) / 0.5), ...angles.map(a => Math.max(0, (a - 60) / 110))];
}

// how open each finger is, where 1 is the relaxed hand; a straighter finger goes above 1
export function openAmounts(metrics, relaxed = NOT_CALIBRATED) {
  return rawOpen(metrics).map((open, i) => open / relaxed[i]);
}

// five booleans, thumb first
export function curledFingers(hand, prev = [false, false, false, false, false], relaxed = NOT_CALIBRATED) {
  return openAmounts(curlMetrics(hand), relaxed).map((open, i) => open < (prev[i] ? CURL_OFF : CURL_ON));
}

export function looksRelaxed(raw) {
  return raw.slice(1).every(open => open >= LOOKS_OPEN);
}

// the middle value of each finger across the calibration frames
export function relaxedFrom(samples) {
  return [0, 1, 2, 3, 4].map(i => {
    const sorted = samples.map(s => s[i]).sort((a, b) => a - b);
    return Math.max(LOWEST_RELAXED, sorted[Math.floor(sorted.length / 2)]);
  });
}

// how much of a new tracking frame to use: steady hands are smoothed, moving hands follow at once
export function followAmount(moved) {
  return Math.min(1, 0.55 + moved * 25);
}

// a new value only counts once it has held for ms
export function steady(state, value, now, ms) {
  if (value !== state.pending) { state.pending = value; state.since = now; }
  if (now - state.since >= ms) state.value = value;
  return state.value;
}

// top of the screen is high
export function yToPitch(y) {
  const t = (y - 0.12) / 0.76;
  return HIGH - Math.max(0, Math.min(1, t)) * (HIGH - LOW);
}

export function isScaleNote(midi) { return SCALE.includes(((midi % 12) + 12) % 12); }

function nearestNote(pitch) {
  for (let d = 0; ; d++) {
    const down = Math.round(pitch) - d, up = Math.round(pitch) + d;
    const best = Math.abs(down - pitch) <= Math.abs(up - pitch) ? [down, up] : [up, down];
    for (const n of best) if (isScaleNote(n)) return n;
  }
}

// the note only changes once pitch is clearly closer to the next one
export function snapNote(pitch, current) {
  const next = nearestNote(pitch);
  if (current == null || next === current) return next;
  return Math.abs(pitch - current) - Math.abs(pitch - next) > 0.5 ? next : current;
}

// fast hand = free glide, slow hand = settled on the note
export function bendAmount(semitonesPerSecond) {
  return Math.max(0, Math.min(1, (Math.abs(semitonesPerSecond) - 2) / 14));
}

function stepScale(midi, steps) {
  let n = midi;
  for (let dir = Math.sign(steps), i = Math.abs(steps); i > 0; i--) {
    do n += dir; while (!isScaleNote(n));
  }
  return n;
}

const CHORDS = [[], [0], [0, 3], [0, 1, 3], [0, 1, 3, 4], [-5, 0, 1, 3, 4, 6]]; // scale steps from the root

// open hand is silent, the more fingers curled in the fuller the sound
export function chordNotes(root, curledCount) {
  return CHORDS[curledCount].map(steps => stepScale(root, steps));
}

export function noteName(midi) { return NAMES[((midi % 12) + 12) % 12]; }
export function midiToHz(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

// left of the screen is dark, right is bright
export function xToCutoff(x) {
  return 280 * Math.pow(5000 / 280, Math.max(0, Math.min(1, x)));
}

// video coordinates to screen coordinates for a mirrored, cover-fitted video
export function coverMap(videoW, videoH, screenW, screenH) {
  const s = Math.max(screenW / videoW, screenH / videoH);
  const dx = (screenW - videoW * s) / 2, dy = (screenH - videoH * s) / 2;
  return p => ({ x: screenW - (dx + p.x * videoW * s), y: dy + p.y * videoH * s });
}
