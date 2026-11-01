import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

test('straight finger is about 180 degrees, folded is small', () => {
  assert.ok(Math.abs(L.jointAngle({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }) - 180) < 0.01);
  assert.ok(L.jointAngle({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0.1, y: 0.1 }) < 10);
});

test('steady only accepts a value once it has held', () => {
  const s = { value: 0, pending: 0, since: 0 };
  assert.equal(L.steady(s, 3, 100, 90), 0);
  assert.equal(L.steady(s, 3, 150, 90), 0);
  assert.equal(L.steady(s, 3, 200, 90), 3);
  assert.equal(L.steady(s, 5, 210, 90), 3);
  assert.equal(L.steady(s, 3, 220, 90), 3);
});

test('pitch rises towards the top and clamps', () => {
  assert.ok(L.yToPitch(0.2) > L.yToPitch(0.8));
  assert.equal(L.yToPitch(-1), L.yToPitch(0.12));
  assert.equal(L.yToPitch(2), L.yToPitch(0.88));
});

test('snapped note is in the scale and resists flicker at a boundary', () => {
  for (let p = 45; p <= 76; p += 0.1) assert.ok(L.isScaleNote(L.snapNote(p, null)));
  assert.equal(L.snapNote(58.1, 57), 57); // barely past the middle of A to C
  assert.equal(L.snapNote(59.5, 57), 60);
});

test('chords grow with the number of curled fingers', () => {
  assert.deepEqual(L.chordNotes(57, 0), []);
  [1, 2, 3, 4].forEach(n => assert.equal(L.chordNotes(57, n).length, n));
  assert.equal(L.chordNotes(57, 5).length, 6);
  assert.deepEqual(L.chordNotes(57, 3), [57, 60, 64]); // A C E
  for (let n = 1; n <= 5; n++) L.chordNotes(57, n).forEach(m => assert.ok(L.isScaleNote(m)));
});

test('note names and frequency', () => {
  assert.equal(L.noteName(57), 'A');
  assert.equal(L.midiToHz(69), 440);
});

test('tone gets brighter to the right', () => {
  assert.ok(L.xToCutoff(0.9) > L.xToCutoff(0.1));
});

test('mirrored cover map flips x and fills the screen', () => {
  const map = L.coverMap(100, 100, 50, 100);
  assert.deepEqual(map({ x: 0.5, y: 0.5 }), { x: 25, y: 50 });
  assert.ok(map({ x: 0.4, y: 0 }).x > 25);
  assert.equal(map({ x: 0.5, y: 0 }).y, 0);
});

test('bend is zero when the hand is slow and full when fast', () => {
  assert.equal(L.bendAmount(1), 0);
  assert.equal(L.bendAmount(-30), 1);
});
