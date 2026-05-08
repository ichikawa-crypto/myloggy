import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import type { SnapshotRecord } from '../../shared/types.js';
import { AppDatabase } from './db.js';

function mockSnapshot(overrides: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return {
    id: 'snap-1',
    capturedAt: new Date().toISOString(),
    imagePath: null,
    imageHash: null,
    imagePaths: [],
    imageHashes: [],
    displayCount: 1,
    cursorX: null,
    cursorY: null,
    cursorDisplayId: null,
    cursorDisplayIndex: null,
    cursorRelativeX: null,
    cursorRelativeY: null,
    activeApp: 'App',
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

test('cleanupOldSnapshots removes old rows without checkpoint_id only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myloggy-db-cleanup-'));
  try {
    const db = new AppDatabase(dir);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();

    db.insertSnapshot(mockSnapshot({ id: 'old-pending', capturedAt: old }));
    db.insertSnapshot(mockSnapshot({ id: 'recent', capturedAt: recent }));
    db.insertSnapshot(
      mockSnapshot({ id: 'old-processed', capturedAt: old, checkpointId: 'cp-1', status: 'processed' }),
    );

    const removed = db.cleanupOldSnapshots(30);
    assert.equal(removed, 1);
    assert.equal(db.getSnapshotById('old-pending'), null);
    assert.ok(db.getSnapshotById('recent'));
    assert.ok(db.getSnapshotById('old-processed'));
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupOldSnapshots deletes old analysis_failed_terminal when not linked to a checkpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myloggy-db-cleanup-'));
  try {
    const db = new AppDatabase(dir);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    db.insertSnapshot(
      mockSnapshot({ id: 'dead', capturedAt: old, status: 'analysis_failed_terminal' }),
    );
    assert.equal(db.cleanupOldSnapshots(30), 1);
    assert.equal(db.getSnapshotById('dead'), null);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cleanupOldErrorLogs deletes rows by created_at cutoff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myloggy-db-cleanup-'));
  try {
    let db = new AppDatabase(dir);
    db.insertError('probe', 'kept-recent');
    db.close();

    const dbPath = path.join(dir, 'myloggy.sqlite');
    const raw = new DatabaseSync(dbPath);
    raw
      .prepare(
        'INSERT INTO error_logs (id, created_at, scope, message, detail) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        'err-old',
        new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString(),
        'probe',
        'stale',
        null,
      );
    raw.close();

    db = new AppDatabase(dir);
    const removed = db.cleanupOldErrorLogs(14);
    assert.equal(removed, 1);
    const errors = db.listErrors(10);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.message, 'kept-recent');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
