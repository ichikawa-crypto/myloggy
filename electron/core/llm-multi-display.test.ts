import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCheckpointLlmOutputWithSecondary, normalizeSecondaryItemOutput } from './llm-response.js';
import { collectVisionImagePaths, materializeSecondaryActivities } from './llm.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import type { SnapshotRecord } from '../../shared/types.js';

function snapshotStub(overrides: Partial<SnapshotRecord> & Pick<SnapshotRecord, 'id'>): SnapshotRecord {
  return {
    id: overrides.id,
    capturedAt: overrides.capturedAt ?? '2026-05-08T00:00:00.000Z',
    imagePath: overrides.imagePath ?? null,
    imageHash: overrides.imageHash ?? null,
    imagePaths: overrides.imagePaths ?? [],
    imageHashes: overrides.imageHashes ?? [],
    displayCount: overrides.displayCount ?? (overrides.imagePaths?.length || 1),
    cursorX: overrides.cursorX ?? null,
    cursorY: overrides.cursorY ?? null,
    cursorDisplayId: overrides.cursorDisplayId ?? null,
    cursorDisplayIndex: overrides.cursorDisplayIndex ?? null,
    cursorRelativeX: overrides.cursorRelativeX ?? null,
    cursorRelativeY: overrides.cursorRelativeY ?? null,
    activeApp: overrides.activeApp ?? null,
    windowTitle: overrides.windowTitle ?? null,
    pageTitle: overrides.pageTitle ?? null,
    url: overrides.url ?? null,
    keyboardActivity: overrides.keyboardActivity ?? null,
    mouseActivity: overrides.mouseActivity ?? null,
    appSwitchCount: overrides.appSwitchCount ?? null,
    gitBranch: overrides.gitBranch ?? null,
    gitDirty: overrides.gitDirty ?? null,
    manualNote: overrides.manualNote ?? null,
    status: overrides.status ?? 'captured',
    excludedReason: overrides.excludedReason ?? null,
    metadataJson: overrides.metadataJson ?? null,
    checkpointId: overrides.checkpointId ?? null,
  };
}

test('collectVisionImagePaths merges newest snapshot per display and caps at MAX_VISION_IMAGES', () => {
  const older = snapshotStub({
    id: 'a',
    capturedAt: '2026-05-08T00:01:00.000Z',
    imagePaths: ['/old-d0.jpg', '/old-d1.jpg', '/should-not-see.jpg'],
    displayCount: 3,
  });
  const newer = snapshotStub({
    id: 'b',
    capturedAt: '2026-05-08T00:02:00.000Z',
    imagePaths: ['/new-d0.jpg', '/new-d1.jpg', '/new-d2.jpg'],
    displayCount: 3,
  });
  const paths = collectVisionImagePaths([older, newer]);
  assert.deepEqual(paths, ['/new-d0.jpg', '/new-d1.jpg', '/new-d2.jpg']);
});

test('collectVisionImagePaths falls back across snapshots when a display is missing later', () => {
  const s1 = snapshotStub({
    id: 'x',
    imagePaths: ['/d0-only-from-old.jpg'],
  });
  const s2 = snapshotStub({
    id: 'y',
    imagePaths: ['', '/d1-from-new.jpg'],
  });
  assert.deepEqual(collectVisionImagePaths([s1, s2]), ['/d0-only-from-old.jpg', '/d1-from-new.jpg']);
});

test('normalizeCheckpointLlmOutputWithSecondary parses primary+secondary', () => {
  const wrapped = JSON.stringify({
    primary: {
      project_name: 'アルボナ',
      category: '開発',
      task_label: 'llm.ts 変更',
      state_summary: 'マルチディスプレイ対応を確認する',
      evidence: ['a', 'b', 'c'],
      continuity: 'continue',
      confidence: 0.8,
      is_distracted: false,
    },
    secondary: [
      {
        display_index: 2,
        project_name: 'TF',
        category: '事務作業',
        task_label: 'データ確認',
        state_summary: 'シート確認',
        evidence: ['sheet A', 'cell B', 'tab C'],
      },
    ],
  });

  const { primary, secondary } = normalizeCheckpointLlmOutputWithSecondary(wrapped);

  assert.equal(primary.project_name, 'アルボナ');
  assert.equal(primary.task_label, 'llm.ts 変更');
  assert.equal(secondary.length, 1);
  assert.equal(secondary[0]!.display_index, 2);
  assert.equal(secondary[0]!.project_name, 'TF');
});

test('normalizeCheckpointLlmOutputWithSecondary keeps legacy flat object as primary with empty secondary', () => {
  const flat = {
    project_name: 'その他',
    task_label: '旧形式',
    state_summary: '互換チェック',
    evidence: ['1', '2', '3'],
    continuity: 'unclear',
    confidence: '0.4',
    is_distracted: false,
    category: '不明',
  };

  const { primary, secondary } = normalizeCheckpointLlmOutputWithSecondary(flat);

  assert.equal(primary.task_label, '旧形式');
  assert.deepEqual(secondary, []);
});

test('materializeSecondaryActivities runs canonicalizeProject on secondary.project_name', () => {
  const raw = {
    display_index: 1,
    project_name: 'TF',
    category: '事務作業',
    task_label: '集計',
    state_summary: '集計確認',
    evidence: ['a', 'b', 'c'],
  };
  const normalized = [normalizeSecondaryItemOutput(raw)];
  const out = materializeSecondaryActivities(normalized, DEFAULT_SETTINGS, 'ja');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.projectName, 'タビケン留学');
});
