import test from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../logic.js';

test('straight finger is about 180 degrees, folded is small', () => {
  assert.ok(Math.abs(L.jointAngle({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }) - 180) < 0.01);
  assert.ok(L.jointAngle({ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0.1, y: 0.1 }) < 10);
});

// a hand whose four fingers bend by the given middle-joint angles, thumb tip at the given distance from the palm
function handWith(angles, thumbReach) {
  const hand = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  hand[9] = { x: 0, y: 1, z: 0 };
  hand[4] = { x: -thumbReach, y: 1, z: 0 };
  [5, 9, 13, 17].forEach((k, i) => {
    const a = angles[i] * Math.PI / 180;
    hand[k] = { x: i - 1, y: 1, z: 0 };
    hand[k + 1] = { x: i - 1, y: 2, z: 0 };
    hand[k + 3] = { x: i - 1 + Math.sin(a), y: 2 - Math.cos(a), z: 0 };
  });
  hand[9] = { x: 0, y: 1, z: 0 };
  return hand;
}
const closed = c => c.filter(Boolean).length;

test('an open hand counts as nothing curled, even when relaxed or with the thumb across the palm', () => {
  assert.equal(closed(L.curledFingers(handWith([170, 170, 170, 170], 1))), 0);
  assert.equal(closed(L.curledFingers(handWith([140, 150, 140, 145], 1))), 0);
  assert.equal(closed(L.curledFingers(handWith([170, 170, 170, 170], 0.2))), 0);
});

test('curled fingers count, and the thumb joins them', () => {
  assert.equal(closed(L.curledFingers(handWith([50, 170, 170, 170], 1))), 1);
  assert.equal(closed(L.curledFingers(handWith([50, 170, 170, 170], 0.2))), 2);
  assert.equal(closed(L.curledFingers(handWith([40, 40, 40, 40], 0.2))), 5);
});

test('a curled finger has to open clearly before it lets go', () => {
  const was = [false, true, false, false, false];
  assert.equal(L.curledFingers(handWith([140, 170, 170, 170], 1), was)[1], true);
  assert.equal(L.curledFingers(handWith([150, 170, 170, 170], 1), was)[1], false);
});

test('a finger counts as curled below 70% open', () => {
  const open = a => L.openAmounts(L.curlMetrics(handWith([a, 170, 170, 170], 1)))[1];
  assert.ok(open(136) < 0.7);
  assert.equal(L.curledFingers(handWith([136, 170, 170, 170], 1))[1], true);
  assert.ok(open(138) > 0.7);
  assert.equal(L.curledFingers(handWith([138, 170, 170, 170], 1))[1], false);
});

test('open amounts run from closed to open', () => {
  const [thumb, index] = L.openAmounts(L.curlMetrics(handWith([170, 170, 170, 170], 1)));
  assert.equal(thumb, 1);
  assert.equal(index, 1);
  assert.equal(L.openAmounts(L.curlMetrics(handWith([40, 170, 170, 170], 0.2)))[1], 0);
});

test('a moving hand follows at once and a still hand is smoothed', () => {
  assert.equal(L.followAmount(0.05), 1);
  assert.ok(L.followAmount(0) < 0.6);
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
