import assert from 'node:assert/strict';
import test from 'node:test';

import type { AppSettings, SnapshotRecord } from '../../shared/types.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { isIdleWindow } from './idle.js';

function mockSnapshot(overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return {
    id: 'snap-1',
    capturedAt: '2026-05-07T00:00:00.000Z',
    imagePath: null,
    imageHash: 'hash-a',
    imagePaths: [],
    imageHashes: [],
    displayCount: 1,
    cursorX: 100,
    cursorY: 200,
    cursorDisplayId: null,
    cursorDisplayIndex: null,
    cursorRelativeX: null,
    cursorRelativeY: null,
    activeApp: 'Safari',
    windowTitle: null,
    pageTitle: null,
    url: null,
    keyboardActivity: null,
    mouseActivity: null,
    appSwitchCount: null,
    gitBranch: null,
    gitDirty: null,
    manualNote: null,
    status: 'captured',
    excludedReason: null,
    metadataJson: null,
    checkpointId: null,
    ...overrides,
  };
}

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

test('isIdleWindow returns false when fewer than 2 snapshots', () => {
  assert.equal(isIdleWindow([], settings()), false);
  assert.equal(isIdleWindow([mockSnapshot()], settings()), false);
});

test('stable cursor but excluded app (Cursor) active → not idle', () => {
  const snaps = [
    mockSnapshot({ id: '1', activeApp: 'Cursor' }),
    mockSnapshot({ id: '2', activeApp: 'Cursor', capturedAt: '2026-05-07T00:01:00.000Z' }),
  ];
  assert.equal(isIdleWindow(snaps, settings()), false);
});

test('stable cursor + Safari + matching imageHash → idle', () => {
  const snaps = [
    mockSnapshot({ id: '1', activeApp: 'Safari', imageHash: 'x' }),
    mockSnapshot({ id: '2', activeApp: 'Safari', imageHash: 'x', capturedAt: '2026-05-07T00:01:00.000Z' }),
  ];
  assert.equal(isIdleWindow(snaps, settings()), true);
});

test('stable cursor + Safari + imageHash changes → not idle', () => {
  const snaps = [
    mockSnapshot({ id: '1', activeApp: 'Safari', imageHash: 'b6b41161' }),
    mockSnapshot({ id: '2', activeApp: 'Safari', imageHash: 'bddac384', capturedAt: '2026-05-07T00:01:00.000Z' }),
  ];
  assert.equal(isIdleWindow(snaps, settings()), false);
});

test('cursor moves + Safari + stable hash → not idle', () => {
  const snaps = [
    mockSnapshot({ id: '1', cursorX: 10, cursorY: 20, imageHash: 'x' }),
    mockSnapshot({
      id: '2',
      cursorX: 50,
      cursorY: 20,
      imageHash: 'x',
      capturedAt: '2026-05-07T00:01:00.000Z',
    }),
  ];
  assert.equal(isIdleWindow(snaps, settings()), false);
});

test('idleRequireStableImage false ignores imageHash drift', () => {
  const snaps = [
    mockSnapshot({ id: '1', imageHash: 'a' }),
    mockSnapshot({ id: '2', imageHash: 'b', capturedAt: '2026-05-07T00:01:00.000Z' }),
  ];
  assert.equal(isIdleWindow(snaps, settings({ idleRequireStableImage: false })), true);
});

test('idleExcludedApps empty does not treat Cursor as exclusion', () => {
  const snaps = [
    mockSnapshot({ id: '1', activeApp: 'Cursor' }),
    mockSnapshot({ id: '2', activeApp: 'Cursor', capturedAt: '2026-05-07T00:01:00.000Z' }),
  ];
  assert.equal(isIdleWindow(snaps, settings({ idleExcludedApps: [] })), true);
});
