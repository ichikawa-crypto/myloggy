import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  AppSettings,
  CheckpointRecord,
  ErrorLogRecord,
  SnapshotRecord,
  WorkUnitPatch,
  WorkUnitRecord,
} from '../../shared/types.js';
import {
  isLegacyDistractedCategory,
  isUnknownLabel,
  toStoredCategoryLabel,
  toStoredProjectName,
} from '../../shared/localization.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { createId, safeJsonParse } from './utils.js';

const MAX_TASK_LABEL = 120;
const MAX_STATE_SUMMARY = 500;
const MAX_PROJECT_NAME = 60;
const MAX_EVIDENCE_ITEM = 80;

type SqlValue = string | number | null;

function normalizeBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  return Boolean(value);
}

function rowToSnapshot(row: Record<string, unknown>): SnapshotRecord {
  const imagePaths = safeJsonParse<string[]>(row.image_paths_json as string | null, []);
  const imageHashes = safeJsonParse<string[]>(row.image_hashes_json as string | null, []);
  const legacyImagePath = (row.image_path as string | null) ?? null;
  const legacyImageHash = (row.image_hash as string | null) ?? null;

  return {
    id: String(row.id),
    capturedAt: String(row.captured_at),
    imagePath: legacyImagePath,
    imageHash: legacyImageHash,
    imagePaths: imagePaths.length ? imagePaths : legacyImagePath ? [legacyImagePath] : [],
    imageHashes: imageHashes.length ? imageHashes : legacyImageHash ? [legacyImageHash] : [],
    displayCount: Number(row.display_count ?? (imagePaths.length || (legacyImagePath ? 1 : 0))),
    cursorX: (row.cursor_x as number | null) ?? null,
    cursorY: (row.cursor_y as number | null) ?? null,
    cursorDisplayId: (row.cursor_display_id as number | null) ?? null,
    cursorDisplayIndex: (row.cursor_display_index as number | null) ?? null,
    cursorRelativeX: (row.cursor_relative_x as number | null) ?? null,
    cursorRelativeY: (row.cursor_relative_y as number | null) ?? null,
    activeApp: (row.active_app as string | null) ?? null,
    windowTitle: (row.window_title as string | null) ?? null,
    pageTitle: (row.page_title as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    keyboardActivity: (row.keyboard_activity as number | null) ?? null,
    mouseActivity: (row.mouse_activity as number | null) ?? null,
    appSwitchCount: (row.app_switch_count as number | null) ?? null,
    gitBranch: (row.git_branch as string | null) ?? null,
    gitDirty: normalizeBoolean(row.git_dirty),
    manualNote: (row.manual_note as string | null) ?? null,
    status: row.status as SnapshotRecord['status'],
    excludedReason: (row.excluded_reason as string | null) ?? null,
    metadataJson: (row.metadata_json as string | null) ?? null,
    checkpointId: (row.checkpoint_id as string | null) ?? null,
  };
}

function rowToCheckpoint(row: Record<string, unknown>): CheckpointRecord {
  const rawCategory = toStoredCategoryLabel(String(row.category));
  return {
    id: String(row.id),
    startAt: String(row.start_at),
    endAt: String(row.end_at),
    projectName: toStoredProjectName(String(row.project_name)),
    taskLabel: String(row.task_label),
    category: rawCategory,
    stateSummary: String(row.state_summary),
    evidence: safeJsonParse<string[]>(row.evidence_json as string | null, []),
    continuity: row.continuity as CheckpointRecord['continuity'],
    confidence: Number(row.confidence),
    sourceSnapshotIds: safeJsonParse<string[]>(row.source_snapshot_ids_json as string | null, []),
    llmModel: String(row.llm_model),
    createdAt: String(row.created_at),
    isDistracted: Boolean(row.is_distracted ?? isLegacyDistractedCategory(rawCategory)),
    status: row.status as CheckpointRecord['status'],
    appSummary: safeJsonParse<string[]>(row.app_summary_json as string | null, []),
    urlSummary: safeJsonParse<string[]>(row.url_summary_json as string | null, []),
  };
}

function rowToWorkUnit(row: Record<string, unknown>): WorkUnitRecord {
  return {
    id: String(row.id),
    startAt: String(row.start_at),
    endAt: String(row.end_at),
    durationMinutes: Number(row.duration_minutes),
    projectName: toStoredProjectName(String(row.project_name)),
    title: String(row.title),
    category: toStoredCategoryLabel(String(row.category)),
    summary: String(row.summary),
    progressLevel: row.progress_level as WorkUnitRecord['progressLevel'],
    isDistracted: Boolean(row.is_distracted),
    checkpointIds: safeJsonParse<string[]>(row.checkpoint_ids_json as string | null, []),
    userEdited: Boolean(row.user_edited),
    updatedAt: String(row.updated_at),
    note: (row.note as string | null) ?? null,
  };
}

function rowToError(row: Record<string, unknown>): ErrorLogRecord {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    scope: String(row.scope),
    message: String(row.message),
    detail: (row.detail as string | null) ?? null,
  };
}

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(private readonly baseDir: string) {
    fs.mkdirSync(baseDir, { recursive: true });
    const dbPath = path.join(baseDir, 'myloggy.sqlite');
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        captured_at TEXT NOT NULL,
        image_path TEXT,
        image_hash TEXT,
        image_paths_json TEXT,
        image_hashes_json TEXT,
        display_count INTEGER NOT NULL DEFAULT 1,
        cursor_x REAL,
        cursor_y REAL,
        cursor_display_id INTEGER,
        cursor_display_index INTEGER,
        cursor_relative_x REAL,
        cursor_relative_y REAL,
        active_app TEXT,
        window_title TEXT,
        page_title TEXT,
        url TEXT,
        keyboard_activity INTEGER,
        mouse_activity INTEGER,
        app_switch_count INTEGER,
        git_branch TEXT,
        git_dirty INTEGER,
        manual_note TEXT,
        status TEXT NOT NULL,
        excluded_reason TEXT,
        metadata_json TEXT,
        checkpoint_id TEXT,
        analysis_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        project_name TEXT NOT NULL,
        task_label TEXT NOT NULL,
        category TEXT NOT NULL,
        state_summary TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        continuity TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_snapshot_ids_json TEXT NOT NULL,
        llm_model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        app_summary_json TEXT NOT NULL,
        url_summary_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_units (
        id TEXT PRIMARY KEY,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        project_name TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        progress_level TEXT NOT NULL,
        is_distracted INTEGER NOT NULL DEFAULT 0,
        checkpoint_ids_json TEXT NOT NULL,
        user_edited INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS error_logs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        scope TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT
      );
    `);
    this.ensureColumn('snapshots', 'image_paths_json', 'TEXT');
    this.ensureColumn('snapshots', 'image_hashes_json', 'TEXT');
    this.ensureColumn('snapshots', 'display_count', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('snapshots', 'cursor_x', 'REAL');
    this.ensureColumn('snapshots', 'cursor_y', 'REAL');
    this.ensureColumn('snapshots', 'cursor_display_id', 'INTEGER');
    this.ensureColumn('snapshots', 'cursor_display_index', 'INTEGER');
    this.ensureColumn('snapshots', 'cursor_relative_x', 'REAL');
    this.ensureColumn('snapshots', 'cursor_relative_y', 'REAL');
    this.ensureColumn('checkpoints', 'is_distracted', 'INTEGER NOT NULL DEFAULT 0');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS category_rules (
        project_name TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    if (!this.db.prepare('SELECT json FROM settings WHERE id = 1').get()) {
      this.saveSettings(DEFAULT_SETTINGS);
    }
  }

  close(): void {
    this.db.close();
  }

  getCategoryRule(projectName: string): string | null {
    const row = this.db
      .prepare('SELECT category FROM category_rules WHERE project_name = ?')
      .get(projectName) as Record<string, unknown> | undefined;
    return row ? String(row.category) : null;
  }

  upsertCategoryRule(projectName: string, category: string): void {
    this.run(
      `INSERT INTO category_rules (project_name, category, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(project_name) DO UPDATE SET category = excluded.category, updated_at = excluded.updated_at`,
      projectName,
      category,
      new Date().toISOString(),
    );
  }

  private run(sql: string, ...params: SqlValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    } catch {
      // Column already exists.
    }
  }

  getSettings(): AppSettings {
    const row = this.db.prepare('SELECT json FROM settings WHERE id = 1').get() as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return DEFAULT_SETTINGS;
    }
    const parsed = safeJsonParse<AppSettings & { mainDisplayOnly?: boolean }>(
      row.json as string,
      DEFAULT_SETTINGS,
    );
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      displayCaptureMode: parsed.displayCaptureMode ?? (parsed.mainDisplayOnly === true ? 'main' : 'all'),
    };
  }

  saveSettings(settings: AppSettings): AppSettings {
    const payload = JSON.stringify(settings);
    const updatedAt = new Date().toISOString();
    this.run(
      `
      INSERT INTO settings (id, json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
      `,
      payload,
      updatedAt,
    );
    return this.getSettings();
  }

  insertSnapshot(snapshot: SnapshotRecord): void {
    this.run(
      `
      INSERT INTO snapshots (
        id, captured_at, image_path, image_hash, image_paths_json, image_hashes_json, display_count, cursor_x, cursor_y, cursor_display_id, cursor_display_index, cursor_relative_x, cursor_relative_y, active_app, window_title, page_title, url,
        keyboard_activity, mouse_activity, app_switch_count, git_branch, git_dirty, manual_note,
        status, excluded_reason, metadata_json, checkpoint_id, analysis_attempts, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      `,
      snapshot.id,
      snapshot.capturedAt,
      snapshot.imagePath,
      snapshot.imageHash,
      JSON.stringify(snapshot.imagePaths),
      JSON.stringify(snapshot.imageHashes),
      snapshot.displayCount,
      snapshot.cursorX,
      snapshot.cursorY,
      snapshot.cursorDisplayId,
      snapshot.cursorDisplayIndex,
      snapshot.cursorRelativeX,
      snapshot.cursorRelativeY,
      snapshot.activeApp,
      snapshot.windowTitle,
      snapshot.pageTitle,
      snapshot.url,
      snapshot.keyboardActivity,
      snapshot.mouseActivity,
      snapshot.appSwitchCount,
      snapshot.gitBranch,
      snapshot.gitDirty === null ? null : snapshot.gitDirty ? 1 : 0,
      snapshot.manualNote,
      snapshot.status,
      snapshot.excludedReason,
      snapshot.metadataJson,
      snapshot.checkpointId,
      new Date().toISOString(),
    );
  }

  getReadySnapshotWindows(intervalMinutes: number, nowIso: string): SnapshotRecord[][] {
    const rows = this.db
      .prepare(
        `
        SELECT *
        FROM snapshots
        WHERE checkpoint_id IS NULL
          AND status IN ('captured', 'analysis_failed')
        ORDER BY captured_at ASC
        `,
      )
      .all() as Record<string, unknown>[];

    const readyBefore = new Date(nowIso).getTime();
    const windows = new Map<string, SnapshotRecord[]>();

    for (const row of rows) {
      const snapshot = rowToSnapshot(row);
      const captured = new Date(snapshot.capturedAt).getTime();
      const windowStart = new Date(snapshot.capturedAt);
      windowStart.setMinutes(Math.floor(windowStart.getMinutes() / intervalMinutes) * intervalMinutes, 0, 0);
      const windowStartIso = windowStart.toISOString();
      const windowEnd = windowStart.getTime() + intervalMinutes * 60_000;
      if (windowEnd > readyBefore) {
        continue;
      }
      const bucket = windows.get(windowStartIso) ?? [];
      bucket.push(snapshot);
      windows.set(windowStartIso, bucket);
      void captured;
    }

    return [...windows.values()];
  }

  incrementAnalysisAttempts(snapshotIds: string[]): void {
    const statement = this.db.prepare(
      'UPDATE snapshots SET analysis_attempts = analysis_attempts + 1, status = ? WHERE id = ?',
    );
    for (const id of snapshotIds) {
      statement.run('analysis_failed', id);
    }
  }

  markSnapshotsProcessed(snapshotIds: string[], checkpointId: string): void {
    const statement = this.db.prepare(
      'UPDATE snapshots SET status = ?, checkpoint_id = ? WHERE id = ?',
    );
    for (const id of snapshotIds) {
      statement.run('processed', checkpointId, id);
    }
  }

  getAnalysisAttempts(snapshotIds: string[]): number {
    const statement = this.db.prepare('SELECT MAX(analysis_attempts) AS attempts FROM snapshots WHERE id = ?');
    return snapshotIds.reduce((max, id) => {
      const row = statement.get(id) as Record<string, unknown> | undefined;
      return Math.max(max, Number(row?.attempts ?? 0));
    }, 0);
  }

  getSnapshotById(id: string): SnapshotRecord | null {
    const row = this.db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToSnapshot(row) : null;
  }

  insertCheckpoint(record: CheckpointRecord): void {
    const truncateToMax = (
      value: string,
      maxLen: number,
      field: 'task_label' | 'state_summary' | 'project_name',
    ): string => {
      if (value.length <= maxLen) {
        return value;
      }
      console.warn('[insertCheckpoint] field truncated:', {
        field,
        originalLength: value.length,
        id: record.id,
      });
      return `${value.slice(0, maxLen - 3)}…`;
    };

    const projectName = truncateToMax(record.projectName, MAX_PROJECT_NAME, 'project_name');
    const taskLabel = truncateToMax(record.taskLabel, MAX_TASK_LABEL, 'task_label');
    const stateSummary = truncateToMax(record.stateSummary, MAX_STATE_SUMMARY, 'state_summary');

    const evidence = record.evidence.map((item, index) => {
      if (item.length <= MAX_EVIDENCE_ITEM) {
        return item;
      }
      console.warn('[insertCheckpoint] field truncated:', {
        field: 'evidence',
        originalLength: item.length,
        id: record.id,
        index,
      });
      return `${item.slice(0, MAX_EVIDENCE_ITEM - 3)}…`;
    });

    this.run(
      `
      INSERT INTO checkpoints (
        id, start_at, end_at, project_name, task_label, category, state_summary, evidence_json,
        continuity, confidence, source_snapshot_ids_json, llm_model, created_at, is_distracted, status,
        app_summary_json, url_summary_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.id,
      record.startAt,
      record.endAt,
      projectName,
      taskLabel,
      record.category,
      stateSummary,
      JSON.stringify(evidence),
      record.continuity,
      record.confidence,
      JSON.stringify(record.sourceSnapshotIds),
      record.llmModel,
      record.createdAt,
      record.isDistracted ? 1 : 0,
      record.status,
      JSON.stringify(record.appSummary),
      JSON.stringify(record.urlSummary),
    );
  }

  listCheckpointsBetween(startIso: string, endIso: string): CheckpointRecord[] {
    return (
      this.db
        .prepare(
          `
          SELECT *
          FROM checkpoints
          WHERE start_at < ?
            AND end_at >= ?
            AND status = 'completed'
          ORDER BY start_at ASC
          `,
        )
        .all(endIso, startIso) as Record<string, unknown>[]
    ).map(rowToCheckpoint);
  }

  getLastCheckpoint(): CheckpointRecord | null {
    const row = this.db
      .prepare("SELECT * FROM checkpoints WHERE status = 'completed' ORDER BY end_at DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return row ? rowToCheckpoint(row) : null;
  }

  getCurrentWorkUnit(): WorkUnitRecord | null {
    const row = this.db.prepare('SELECT * FROM work_units ORDER BY end_at DESC LIMIT 1').get() as
      | Record<string, unknown>
      | undefined;
    return row ? rowToWorkUnit(row) : null;
  }

  insertWorkUnit(record: WorkUnitRecord): void {
    this.run(
      `
      INSERT INTO work_units (
        id, start_at, end_at, duration_minutes, project_name, title, category, summary,
        progress_level, is_distracted, checkpoint_ids_json, user_edited, updated_at, note
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      record.id,
      record.startAt,
      record.endAt,
      record.durationMinutes,
      record.projectName,
      record.title,
      record.category,
      record.summary,
      record.progressLevel,
      record.isDistracted ? 1 : 0,
      JSON.stringify(record.checkpointIds),
      record.userEdited ? 1 : 0,
      record.updatedAt,
      record.note,
    );
  }

  updateWorkUnit(record: WorkUnitRecord): void {
    this.run(
      `
      UPDATE work_units
      SET start_at = ?, end_at = ?, duration_minutes = ?, project_name = ?, title = ?, category = ?,
          summary = ?, progress_level = ?, is_distracted = ?, checkpoint_ids_json = ?,
          user_edited = ?, updated_at = ?, note = ?
      WHERE id = ?
      `,
      record.startAt,
      record.endAt,
      record.durationMinutes,
      record.projectName,
      record.title,
      record.category,
      record.summary,
      record.progressLevel,
      record.isDistracted ? 1 : 0,
      JSON.stringify(record.checkpointIds),
      record.userEdited ? 1 : 0,
      record.updatedAt,
      record.note,
      record.id,
    );
  }

  patchWorkUnit(patch: WorkUnitPatch): WorkUnitRecord | null {
    const normalizedPatch: WorkUnitPatch = {
      ...patch,
      projectName: patch.projectName === undefined ? undefined : toStoredProjectName(patch.projectName),
      category: patch.category === undefined ? undefined : toStoredCategoryLabel(patch.category),
    };
    const current = this.getWorkUnitById(normalizedPatch.id);
    if (!current) {
      return null;
    }
    const updated: WorkUnitRecord = {
      ...current,
      ...normalizedPatch,
      note: normalizedPatch.note === undefined ? current.note : normalizedPatch.note,
      userEdited: true,
      updatedAt: new Date().toISOString(),
    };
    this.updateWorkUnit(updated);
    if (normalizedPatch.category && updated.projectName && !isUnknownLabel(updated.projectName)) {
      this.upsertCategoryRule(updated.projectName, updated.category);
    }
    return updated;
  }

  getWorkUnitById(id: string): WorkUnitRecord | null {
    const row = this.db.prepare('SELECT * FROM work_units WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToWorkUnit(row) : null;
  }

  listWorkUnitsBetween(startIso: string, endIso: string): WorkUnitRecord[] {
    return (
      this.db
        .prepare(
          `
          SELECT *
          FROM work_units
          WHERE start_at < ?
            AND end_at >= ?
          ORDER BY start_at ASC
          `,
        )
        .all(endIso, startIso) as Record<string, unknown>[]
    ).map(rowToWorkUnit);
  }

  listRecentSnapshots(limit = 20): SnapshotRecord[] {
    return (
      this.db.prepare('SELECT * FROM snapshots ORDER BY captured_at DESC LIMIT ?').all(limit) as Record<string, unknown>[]
    ).map(rowToSnapshot);
  }

  listPendingSnapshots(): SnapshotRecord[] {
    return (
      this.db
        .prepare(
          `
          SELECT *
          FROM snapshots
          WHERE checkpoint_id IS NULL
            AND status IN ('captured', 'analysis_failed')
          ORDER BY captured_at ASC
          `,
        )
        .all() as Record<string, unknown>[]
    ).map(rowToSnapshot);
  }

  clearPendingSnapshots(): SnapshotRecord[] {
    const snapshots = this.listPendingSnapshots();
    if (!snapshots.length) {
      return [];
    }

    const statement = this.db.prepare('DELETE FROM snapshots WHERE id = ?');
    for (const snapshot of snapshots) {
      statement.run(snapshot.id);
    }

    return snapshots;
  }

  listRecentWorkUnits(limit = 8): WorkUnitRecord[] {
    return (
      this.db.prepare('SELECT * FROM work_units ORDER BY end_at DESC LIMIT ?').all(limit) as Record<
        string,
        unknown
      >[]
    ).map(rowToWorkUnit);
  }

  insertError(scope: string, message: string, detail?: string | null): ErrorLogRecord {
    const error: ErrorLogRecord = {
      id: createId('err'),
      createdAt: new Date().toISOString(),
      scope,
      message,
      detail: detail ?? null,
    };
    this.run(
      'INSERT INTO error_logs (id, created_at, scope, message, detail) VALUES (?, ?, ?, ?, ?)',
      error.id,
      error.createdAt,
      error.scope,
      error.message,
      error.detail,
    );
    return error;
  }

  listErrors(limit = 20): ErrorLogRecord[] {
    return (
      this.db.prepare('SELECT * FROM error_logs ORDER BY created_at DESC LIMIT ?').all(limit) as Record<
        string,
        unknown
      >[]
    ).map(rowToError);
  }

  clearErrors(): void {
    this.db.prepare('DELETE FROM error_logs').run();
  }

  countPendingSnapshots(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS total FROM snapshots WHERE checkpoint_id IS NULL AND status IN ('captured', 'analysis_failed')")
      .get() as Record<string, unknown>;
    return Number(row.total);
  }
}
