import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, fitWithin, qualitySteps } from '../src/compress.ts';

test('photos are resized so the long edge fits, keeping their shape; small ones are left alone', () => {
  assert.deepEqual(fitWithin(4000, 3000, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(fitWithin(3000, 4000, 1600), { width: 1200, height: 1600 });
  assert.deepEqual(fitWithin(1200, 900, 1600), { width: 1200, height: 900 });
});

test('quality steps down until small enough, never below 0.4', () => {
  assert.deepEqual(qualitySteps(0.72), [0.72, 0.62, 0.52, 0.42]);
  assert.ok(PROFILES.document.maxEdge > PROFILES.photo.maxEdge, 'invoices stay readable');
  assert.ok(PROFILES.picture.keepPng, 'logos keep see-through');
});
