import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrainData } from './data.ts';
import { dataInfoLine } from './info.ts';

test('the info line reports what was actually loaded', () => {
  // main.swift:725 — the tray shows this, so its numbers must come from the data
  // rather than being typed in.
  const { points, circuit } = loadBrainData()!;
  const line = dataInfoLine(points, circuit);
  assert.match(line, /FlyWire v783/);
  assert.match(line, /23,210 somas/);
  assert.match(line, /668n/);
  assert.match(line, /18,968e/);
});

test('missing data says so instead of showing zeros', () => {
  assert.match(dataInfoLine(null, null), /no data/);
  assert.doesNotMatch(dataInfoLine(null, null), /0 somas/);
});

test('thousands separators appear, so 23210 is readable', () => {
  const { points, circuit } = loadBrainData()!;
  assert.doesNotMatch(dataInfoLine(points, circuit), /23210/);
});
