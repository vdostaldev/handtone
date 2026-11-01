// pure hand and music maths, no browser needed (tested by test/logic.test.mjs)

const FINGERS = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]]; // knuckle, middle joint, tip
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const SCALE = [0, 2, 4, 7, 9]; // pentatonic, so any two notes sound fine together
const LOW = 45, HIGH = 76;     // A2 to E5

// curled keeps a finger's previous state in the gap between the thresholds, so it doesn't flicker
// curled below 70% open on the values tab, and open again at 77%
const CURL_ON = 137, CURL_OFF = 145;      // finger: degrees at the middle joint
const THUMB_ON = 0.70, THUMB_OFF = 0.735; // thumb: tip to palm centre, in palm lengths

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

// five booleans, thumb first
export function curledFingers(hand, prev = [false, false, false, false, false]) {
  const { angles, thumb } = curlMetrics(hand);
  const fingers = angles.map((a, i) => a < (prev[i + 1] ? CURL_OFF : CURL_ON));
  // a thumb resting across an open palm is not a closed hand, so it only counts alongside a finger
  const thumbCurled = fingers.some(Boolean) && thumb < (prev[0] ? THUMB_OFF : THUMB_ON);
  return [thumbCurled, ...fingers];
}

// 0 to 1 per finger, thumb first, for showing how open each one is
export function openAmounts({ angles, thumb }) {
  const clamp = v => Math.max(0, Math.min(1, v));
  return [clamp((thumb - 0.35) / 0.5), ...angles.map(a => clamp((a - 60) / 110))];
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
