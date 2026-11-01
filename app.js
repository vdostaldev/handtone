import { FilesetResolver, HandLandmarker } from './vendor/vision_bundle.mjs';
import {
  curledFingers, curlMetrics, steady, yToPitch, snapNote, bendAmount,
  chordNotes, noteName, midiToHz, xToCutoff, coverMap, openAmounts, followAmount,
  rawOpen, looksRelaxed, relaxedFrom,
} from './logic.js';

const BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
const PALM = [0, 5, 9, 13, 17];
const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const LINE = '#30d5c8';
const CHANGE_MS = 60;      // a chord change has to hold this long
const LOST_MS = 250;       // a hand can vanish this long without the sound stopping
const CALIBRATE_MS = 2000; // how long to hold a relaxed hand up
const CALIBRATE_GAP_MS = 1500; // losing the relaxed hand this long starts the hold over
const MATCH_DISTANCE = 0.3;
const MAX_VOICES = 6;

const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const g = canvas.getContext('2d');
const loader = document.getElementById('loader');
const tapLabel = document.getElementById('tap');
const valuesTab = document.getElementById('values');
const valuesBody = document.getElementById('valuesBody');
const valuesData = document.getElementById('valuesData');
const recalibrate = document.getElementById('recalibrate');
const calibrateBox = document.getElementById('calibrate');
const calibrateBar = document.getElementById('calibrateBar');
const debug = location.hash === '#debug';

let tracker = null, audio = null, stream = null, running = false;
let lastVideoTime = -1, screenW = 0, screenH = 0, frames = 0;
let engine = '', trackMs = 0, trackRate = 0, lastTrack = 0, lastValues = 0;
let relaxed = undefined, calibration = null;
const slots = [null, null];

// ---- tracking ----

async function makeTracker() {
  const files = await FilesetResolver.forVisionTasks(new URL('vendor/wasm', location.href).href);
  const options = delegate => ({
    baseOptions: { modelAssetPath: new URL('vendor/hand_landmarker.task', location.href).href, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
  });
  try {
    const made = await HandLandmarker.createFromOptions(files, options('GPU'));
    engine = 'GPU';
    return made;
  } catch (err) {
    console.warn('GPU tracking failed, using CPU', err);
    engine = 'CPU';
    return HandLandmarker.createFromOptions(files, options('CPU'));
  }
}

function palmCentre(hand) {
  let x = 0, y = 0;
  PALM.forEach(i => { x += hand[i].x; y += hand[i].y; });
  return { x: x / PALM.length, y: y / PALM.length };
}

function newSlot(index) {
  return {
    index, hand: null, centre: null, lastSeen: 0, lastTime: 0,
    curled: [false, false, false, false, false],
    count: { value: 0, pending: 0, since: 0 },
    pitch: null, note: null, bend: 0, screen: null,
  };
}

// keeps each hand on its own voice from frame to frame
function matchHands(result, now) {
  const free = new Set(result.landmarks.keys());
  const pairs = [];
  slots.forEach((slot, s) => {
    if (!slot) return;
    free.forEach(i => {
      const c = palmCentre(result.landmarks[i]);
      const d = Math.hypot(c.x - slot.centre.x, c.y - slot.centre.y);
      if (d < MATCH_DISTANCE) pairs.push({ s, i, d });
    });
  });
  pairs.sort((a, b) => a.d - b.d);
  const taken = new Set();
  const seen = [];
  pairs.forEach(({ s, i }) => {
    if (taken.has(s) || !free.has(i)) return;
    taken.add(s); free.delete(i);
    seen.push([slots[s], i]);
  });
  free.forEach(i => {
    const s = slots.findIndex(x => !x);
    if (s < 0) return;
    slots[s] = newSlot(s);
    seen.push([slots[s], i]);
  });
  seen.forEach(([slot, i]) => updateSlot(slot, result.landmarks[i], result.worldLandmarks[i], now));
  slots.forEach((slot, s) => {
    if (slot && now - slot.lastSeen > LOST_MS) {
      if (audio) audio.voices[s].silence();
      slots[s] = null;
    }
  });
}

function updateSlot(slot, landmarks, world, now) {
  const fresh = palmCentre(landmarks);
  const follow = slot.centre ? followAmount(Math.hypot(fresh.x - slot.centre.x, fresh.y - slot.centre.y)) : 1;
  slot.hand = landmarks.map((p, i) => slot.hand
    ? { x: slot.hand[i].x + (p.x - slot.hand[i].x) * follow, y: slot.hand[i].y + (p.y - slot.hand[i].y) * follow }
    : { x: p.x, y: p.y });
  slot.centre = palmCentre(slot.hand);
  slot.lastSeen = now;

  slot.metrics = curlMetrics(world);
  if (calibration) collectRelaxed(slot.metrics, now);
  slot.curled = curledFingers(world, slot.curled, relaxed);
  const raw = calibration ? 0 : slot.curled.filter(Boolean).length;
  const count = steady(slot.count, raw, now, calibration ? 0 : CHANGE_MS);

  const map = coverMap(video.videoWidth, video.videoHeight, screenW, screenH);
  slot.screen = map(slot.centre);
  const pitch = yToPitch(slot.screen.y / screenH);
  const dt = Math.max(1, now - (slot.lastTime || now - 33)) / 1000;
  const speed = slot.pitch == null ? 0 : (pitch - slot.pitch) / dt;
  slot.pitch = pitch;
  slot.lastTime = now;
  slot.note = snapNote(pitch, slot.note);
  slot.bend += (bendAmount(speed) - slot.bend) * 0.3;

  if (audio) {
    audio.voices[slot.index].play(
      chordNotes(slot.note, count),
      (pitch - slot.note) * slot.bend,
      xToCutoff(slot.screen.x / screenW),
    );
  }
}

// ---- calibration ----

function startCalibration() {
  calibration = { samples: [], start: 0, last: 0 };
  relaxed = undefined;
  calibrateBar.style.width = '0';
  calibrateBox.classList.add('on');
}

function collectRelaxed(metrics, now) {
  const raw = rawOpen(metrics);
  if (!looksRelaxed(raw)) return;
  if (now - calibration.last > CALIBRATE_GAP_MS) {
    calibration.samples = [];
    calibration.start = now;
  }
  calibration.last = now;
  calibration.samples.push(raw);
}

function updateCalibration(now) {
  const held = now - calibration.last > CALIBRATE_GAP_MS ? 0 : (calibration.last - calibration.start) / CALIBRATE_MS;
  calibrateBar.style.width = `${Math.min(100, held * 100)}%`;
  if (held < 1) return;
  relaxed = relaxedFrom(calibration.samples);
  calibration = null;
  calibrateBox.classList.remove('on');
  slots.forEach(slot => { if (slot) slot.curled = [false, false, false, false, false]; });
}

// ---- sound ----

class Voice {
  constructor(ctx, out, vibrato) {
    this.ctx = ctx;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.Q.value = 1;
    this.filter.connect(out);
    this.oscs = [];
    for (let i = 0; i < MAX_VOICES; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      gain.gain.value = 0;
      vibrato.connect(osc.detune);
      osc.connect(gain).connect(this.filter);
      osc.start();
      this.oscs.push({ osc, gain, level: 0 });
    }
  }

  play(notes, bend, cutoff) {
    const t = this.ctx.currentTime;
    this.filter.frequency.setTargetAtTime(cutoff, t, 0.05);
    const level = notes.length ? 0.32 / Math.sqrt(notes.length) : 0;
    this.oscs.forEach((v, i) => {
      if (i < notes.length) {
        const hz = midiToHz(notes[i] + bend);
        if (v.level === 0) v.osc.frequency.setValueAtTime(hz, t); // a silent note starts in tune
        else if (Math.abs(v.osc.frequency.value - hz) > 0.2) v.osc.frequency.setTargetAtTime(hz, t, 0.03);
      }
      // only touch the gain while it is away from where it should be
      const want = i < notes.length ? level : 0;
      if (Math.abs(v.gain.gain.value - want) > 0.002) v.gain.gain.setTargetAtTime(want, t, 0.05);
      v.level = want;
    });
  }

  silence() { this.play([], 0, 1000); }
}

function makeAudio() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume();
  const lfo = ctx.createOscillator();
  const vibrato = ctx.createGain();
  lfo.frequency.value = 5;
  vibrato.gain.value = 5; // cents
  lfo.connect(vibrato);
  lfo.start();
  const comp = ctx.createDynamicsCompressor();
  comp.connect(ctx.destination);
  const analyser = ctx.createAnalyser();
  comp.connect(analyser);
  return { ctx, analyser, voices: [new Voice(ctx, comp, vibrato), new Voice(ctx, comp, vibrato)] };
}

// ---- drawing ----

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  screenW = window.innerWidth;
  screenH = window.innerHeight;
  canvas.width = screenW * dpr;
  canvas.height = screenH * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawHand(slot, map) {
  const pts = slot.hand.map(map);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = LINE;
  g.lineWidth = 2;
  g.beginPath();
  BONES.forEach(([a, b]) => { g.moveTo(pts[a].x, pts[a].y); g.lineTo(pts[b].x, pts[b].y); });
  g.stroke();
  g.fillStyle = LINE;
  pts.forEach(p => { g.beginPath(); g.arc(p.x, p.y, 2.5, 0, Math.PI * 2); g.fill(); });

  if (slot.count.value > 0) {
    const top = Math.min(...pts.map(p => p.y));
    g.font = '400 42px "Source Serif 4", Georgia, serif';
    g.textAlign = 'center';
    g.fillStyle = '#fff';
    g.fillText(noteName(slot.note), slot.screen.x, Math.max(44, top - 18));
  }
}

// ---- values tab ----

function bar(label, amount, curled) {
  const pct = Math.round(amount * 100);
  return `<div class="row"><span>${label}</span><i class="${curled ? 'shut' : ''}"><b style="width:${Math.min(100, pct)}%"></b></i><span>${pct}%</span></div>`;
}

function line(label, value) {
  return `<div class="row"><span>${label}</span><span>${value}</span></div>`;
}

function renderValues(now) {
  if (valuesBody.hidden || now - lastValues < 120) return;
  lastValues = now;
  const cam = stream ? stream.getVideoTracks()[0].getSettings() : {};
  let html = line('tracking', `${Math.round(trackRate)}/s`)
    + line('each look', `${Math.round(trackMs)} ms`)
    + line('runs on', engine)
    + line('relaxed', calibration ? 'measuring' : relaxed ? 'set' : 'not set')
    + line('camera', `${video.videoWidth}\u00d7${video.videoHeight} ${Math.round(cam.frameRate || 0)}/s`);
  slots.forEach((slot, s) => {
    if (!slot || !slot.metrics) return;
    const open = openAmounts(slot.metrics, relaxed);
    html += `<h2>hand ${s + 1}</h2>`
      + FINGER_NAMES.map((name, i) => bar(name, open[i], slot.curled[i])).join('')
      + line('curled', slot.count.value)
      + line('note', slot.count.value ? noteName(slot.note) : '\u2013')
      + line('pitch', slot.pitch.toFixed(1))
      + line('glide', `${Math.round(slot.bend * 100)}%`)
      + line('tone', `${Math.round(xToCutoff(slot.screen.x / screenW))} Hz`);
  });
  if (!slots.some(Boolean)) html += '<h2>no hands seen</h2>';
  valuesData.innerHTML = html;
}

function nextFrame() {
  // the moment a camera frame arrives where the browser can say so, otherwise the next screen refresh
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(frame);
  else requestAnimationFrame(frame);
}

function frame() {
  if (!running) return;
  nextFrame();
  if (video.readyState < 2 || !video.videoWidth) return;
  const now = performance.now();
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = tracker.detectForVideo(video, now);
    const done = performance.now();
    trackMs += (done - now - trackMs) * 0.1;
    if (lastTrack) trackRate += (1000 / Math.max(1, now - lastTrack) - trackRate) * 0.1;
    lastTrack = now;
    matchHands(result, now);
    if (calibration) updateCalibration(now);
    frames++;
  }
  g.clearRect(0, 0, screenW, screenH);
  const map = coverMap(video.videoWidth, video.videoHeight, screenW, screenH);
  slots.forEach(slot => { if (slot) drawHand(slot, map); });
  renderValues(now);
}

// ---- starting up ----

async function openCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } },
  });
  video.srcObject = stream;
  await video.play();
}

function showMessage(text) {
  tapLabel.textContent = text;
  tapLabel.classList.add('on', 'long');
}

function showError(err) {
  console.error(err);
  showMessage(err && err.name === 'NotAllowedError'
    ? 'camera blocked, allow it in settings, safari, camera, then tap'
    : 'could not start, tap to try again');
  starting = false;
}

let starting = false;
const trackerReady = makeTracker();
trackerReady.then(() => {
  document.fonts.load('42px "Source Serif 4"').catch(() => {});
  tapLabel.classList.add('on');
}, err => {
  console.error(err);
  showMessage('could not load the hand tracking');
});

loader.addEventListener('click', async () => {
  if (starting || !tapLabel.classList.contains('on')) return;
  starting = true;
  tapLabel.classList.remove('on');
  try {
    // inside the tap, or the iPhone keeps the sound off; playback also ignores the silent switch where it can
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    if (!audio) audio = makeAudio();
    await openCamera();
    tracker = await trackerReady;
    resize();
    loader.classList.add('off');
    valuesTab.classList.add('on');
    startCalibration();
    running = true;
    nextFrame();
  } catch (err) {
    showError(err);
  }
});

valuesTab.addEventListener('click', () => {
  valuesBody.hidden = !valuesBody.hidden;
  lastValues = 0;
});

recalibrate.addEventListener('click', event => {
  event.stopPropagation();
  startCalibration();
});

window.addEventListener('resize', resize);

// the iPhone stops the camera and sound when the app is left
document.addEventListener('visibilitychange', async () => {
  if (!running) return;
  if (document.hidden) {
    audio.voices.forEach(v => v.silence());
    slots.fill(null);
    return;
  }
  audio.ctx.resume();
  try {
    if (!stream.getVideoTracks().some(t => t.readyState === 'live')) await openCamera();
    else await video.play();
  } catch (err) {
    console.error(err);
  }
});

if ('serviceWorker' in navigator && !debug) navigator.serviceWorker.register('sw.js');

if (debug) {
  window.__hands = {
    slots,
    relaxed: () => relaxed,
    calibrating: () => !!calibration,
    skipCalibration() { calibration = null; calibrateBox.classList.remove('on'); },
    audioState: () => audio && audio.ctx.state,
    frames: () => frames,
    level() {
      const data = new Float32Array(2048);
      audio.analyser.getFloatTimeDomainData(data);
      return Math.max(...data.map(Math.abs));
    },
    voiceHz: i => audio.voices[i].oscs.map(v => (v.level > 0 ? Math.round(v.osc.frequency.value) : 0)),
    frequencyNow: i => audio.voices[i].filter.frequency.value,
  };
}
