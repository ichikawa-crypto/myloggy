import fs from 'node:fs';
import path from 'node:path';

import dayjs from 'dayjs';

import {
  UNKNOWN_LABEL,
  isSupportedLocale,
  isUnknownLabel,
  localizeIdleEvidence,
  localizeIdleSummary,
  localizeIdleTaskLabel,
  resolveLocalePreference,
  toStoredCategoryLabel,
  type SupportedLocale,
} from '../../shared/localization.js';
import type {
  AppSettings,
  AppState,
  BootstrapPayload,
  DashboardData,
  DebugData,
  DebugSnapshot,
  SnapshotRecord,
  WorkUnitPatch,
  WorkUnitRecord,
} from '../../shared/types.js';
import { AppDatabase } from './db.js';
import { captureScreenshot, deleteScreenshots } from './capture.js';
import { DEFAULT_SETTINGS } from './defaults.js';
import { shouldExcludeSnapshot } from './exclusions.js';
import { analyzeWindow, pingOllama } from './llm.js';
import { collectMetadata } from './metadata.js';
import { buildDashboard, buildDayTimeline, buildMonthTimeline, buildWeekTimeline } from './timeline.js';
import { createWorkUnitFromCheckpoint, mergeCheckpointIntoWorkUnit, shouldMergeWorkUnit } from './work-units.js';
import { createId, minutesBetween } from './utils.js';

function normalizeSettings(settings: AppSettings): AppSettings {
  const categories = [...new Set((settings.categories ?? DEFAULT_SETTINGS.categories).map((item) => toStoredCategoryLabel(item)).filter(Boolean))];
  return {
    ...settings,
    language: isSupportedLocale(settings.language) ? settings.language : undefined,
    categories: categories.length ? categories : DEFAULT_SETTINGS.categories,
  };
}

export class TrackerService {
  private readonly db: AppDatabase;
  private readonly tempDir: string;
  private settings: AppSettings;
  private captureTimer: NodeJS.Timeout | null = null;
  private analyzeTimer: NodeJS.Timeout | null = null;
  private isAnalyzing = false;
  private isSuspended = false;
  private analyzeSuppressedUntil = 0;
  private resumeTimer: NodeJS.Timeout | null = null;
  private lastCaptureAt: string | null = null;
  private lastCheckpointAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly systemLocale: SupportedLocale,
  ) {
    fs.mkdirSync(baseDir, { recursive: true });
    this.tempDir = path.join(baseDir, 'temp-snaps');
    fs.mkdirSync(this.tempDir, { recursive: true });
    this.db = new AppDatabase(baseDir);
    this.settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      ...this.db.getSettings(),
    });

    // Auto-detect OS language on first launch and persist it
    if (!this.settings.language) {
      this.settings = this.db.saveSettings({
        ...this.settings,
        language: systemLocale,
      });
    }
  }

  private get locale(): SupportedLocale {
    return resolveLocalePreference(this.settings.language, this.systemLocale);
  }

  start(): void {
    this.reschedule();
    void pingOllama(this.settings).catch(() => {});
    setTimeout(() => {
      void this.analyzeReadyWindows();
    }, 5_000);
  }

  onSuspend(): void {
    this.isSuspended = true;
  }

  onResume(): void {
    this.isSuspended = false;
    this.analyzeSuppressedUntil = Date.now() + 60_000;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
    }
    this.resumeTimer = setTimeout(async () => {
      try {
        await pingOllama(this.settings);
      } catch {}
      void this.analyzeReadyWindows();
    }, 60_000);
  }

  dispose(): void {
    if (this.captureTimer) {
      clearInterval(this.captureTimer);
    }
    if (this.analyzeTimer) {
      clearInterval(this.analyzeTimer);
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
    }
    this.db.close();
  }

  getState(): AppState {
    return {
      isTracking: this.settings.isTracking,
      isAnalyzing: this.isAnalyzing,
      pendingSnapshots: this.db.countPendingSnapshots(),
      pendingWindows: this.db.getReadySnapshotWindows(this.settings.checkIntervalMinutes, new Date().toISOString()).length,
      lastCaptureAt: this.lastCaptureAt,
      lastCheckpointAt: this.lastCheckpointAt,
      lastError: this.lastError,
      currentWorkUnit: this.db.getCurrentWorkUnit(),
    };
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  getBootstrap(date: string): BootstrapPayload {
    const state = this.getState();
    return {
      locale: this.locale,
      state,
      settings: this.settings,
      dashboard: buildDashboard(this.db, date, state, this.locale),
    };
  }

  getDashboard(date: string): DashboardData {
    return buildDashboard(this.db, date, this.getState(), this.locale);
  }

  getDayTimeline(date: string) {
    return buildDayTimeline(this.db, date);
  }

  getWeekTimeline(date: string) {
    return buildWeekTimeline(this.db, date);
  }

  getMonthTimeline(date: string) {
    return buildMonthTimeline(this.db, date, this.locale);
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.settings = this.db.saveSettings(normalizeSettings({
      ...this.settings,
      ...patch,
    }));
    this.reschedule();
    return this.settings;
  }

  setTracking(enabled: boolean): AppState {
    this.settings = this.db.saveSettings({
      ...this.settings,
      isTracking: enabled,
    });
    this.reschedule();
    return this.getState();
  }

  async captureNow(): Promise<AppState> {
    await this.captureSnapshot(true);
    return this.getState();
  }

  async analyzeNow(): Promise<AppState> {
    await this.analyzeReadyWindows(true);
    return this.getState();
  }

  async clearPendingSnapshots(): Promise<AppState> {
    const pending = this.db.clearPendingSnapshots();
    await deleteScreenshots(pending);
    if (!this.db.countPendingSnapshots()) {
      this.lastError = null;
    }
    return this.getState();
  }

  clearErrors(): AppState {
    this.db.clearErrors();
    this.lastError = null;
    return this.getState();
  }

  updateWorkUnit(patch: WorkUnitPatch): WorkUnitRecord | null {
    const updated = this.db.patchWorkUnit(patch);
    if (updated) {
      this.ensureCategoryInSettings(updated.category);
    }
    return updated;
  }

  getDebugData(): DebugData {
    const recentSnaps = this.db.listRecentSnapshots(20);
    const snapshots: DebugSnapshot[] = recentSnaps.map((s) => {
      const paths = s.imagePaths.length ? s.imagePaths : s.imagePath ? [s.imagePath] : [];
      const imagesBase64: string[] = [];
      for (const p of paths) {
        if (fs.existsSync(p)) {
          try { imagesBase64.push(fs.readFileSync(p).toString('base64')); } catch { /* ignore */ }
        }
      }
      return {
        id: s.id,
        capturedAt: s.capturedAt,
        activeApp: s.activeApp,
        windowTitle: s.windowTitle,
        pageTitle: s.pageTitle,
        url: s.url,
        cursorX: s.cursorX,
        cursorY: s.cursorY,
        cursorDisplayIndex: s.cursorDisplayIndex,
        status: s.status,
        checkpointId: s.checkpointId,
        imagesBase64,
        displayCount: s.displayCount,
      };
    });
    return {
      snapshots,
      errors: this.db.listErrors(10),
    };
  }

  private ensureCategoryInSettings(category: string): void {
    const normalizedCategory = toStoredCategoryLabel(category);
    if (!normalizedCategory || isUnknownLabel(normalizedCategory) || this.settings.categories.includes(normalizedCategory)) {
      return;
    }

    this.settings = this.db.saveSettings(normalizeSettings({
      ...this.settings,
      categories: [...this.settings.categories, normalizedCategory],
    }));
  }

  private isIdleWindow(snapshots: SnapshotRecord[]): boolean {
    if (snapshots.length < 2) return false;
    const withCursor = snapshots.filter((s) => s.cursorX !== null && s.cursorY !== null);
    if (withCursor.length < 2) return false;
    const refX = withCursor[0]!.cursorX!;
    const refY = withCursor[0]!.cursorY!;
    return withCursor.every((s) => Math.abs(s.cursorX! - refX) <= 1 && Math.abs(s.cursorY! - refY) <= 1);
  }

  private createIdleCheckpoint(snapshots: SnapshotRecord[]): import('../../shared/types.js').CheckpointRecord {
    const startAt = snapshots[0]!.capturedAt;
    const endAt = snapshots.at(-1)!.capturedAt;
    return {
      id: createId('cp'),
      startAt,
      endAt,
      projectName: UNKNOWN_LABEL,
      taskLabel: localizeIdleTaskLabel(this.locale),
      category: '休憩',
      stateSummary: localizeIdleSummary(this.locale),
      evidence: [localizeIdleEvidence(this.locale)],
      continuity: 'unclear',
      confidence: 0.95,
      sourceSnapshotIds: snapshots.map((s) => s.id),
      llmModel: 'auto-idle',
      createdAt: new Date().toISOString(),
      isDistracted: false,
      status: 'completed',
      appSummary: [],
      urlSummary: [],
    };
  }

  private reschedule(): void {
    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    if (this.analyzeTimer) {
      clearInterval(this.analyzeTimer);
      this.analyzeTimer = null;
    }

    if (!this.settings.isTracking) {
      return;
    }

    this.captureTimer = setInterval(() => {
      void this.captureSnapshot();
    }, this.settings.captureIntervalMinutes * 60_000);

    this.analyzeTimer = setInterval(() => {
      void this.analyzeReadyWindows();
    }, this.settings.checkIntervalMinutes * 60_000);
  }

  private async captureSnapshot(force = false): Promise<void> {
    if (this.isSuspended) {
      return;
    }
    if (!this.settings.isTracking && !force) {
      return;
    }

    try {
      const capturedAt = new Date().toISOString();
      const metadata = await collectMetadata();
      const exclusion = shouldExcludeSnapshot(this.settings, {
        activeApp: metadata.activeApp,
        url: metadata.url,
        capturedAt,
      });

      if (exclusion.excluded) {
        return;
      }

      const snapshotId = createId('snap');
      const capture = await captureScreenshot(this.tempDir, snapshotId, this.settings.displayCaptureMode);

      const snapshot: SnapshotRecord = {
        id: snapshotId,
        capturedAt,
        imagePath: capture.imagePath,
        imageHash: capture.imageHash,
        imagePaths: capture.imagePaths,
        imageHashes: capture.imageHashes,
        displayCount: capture.displayCount,
        cursorX: metadata.cursorX,
        cursorY: metadata.cursorY,
        cursorDisplayId: metadata.cursorDisplayId,
        cursorDisplayIndex: metadata.cursorDisplayIndex,
        cursorRelativeX: metadata.cursorRelativeX,
        cursorRelativeY: metadata.cursorRelativeY,
        activeApp: metadata.activeApp,
        windowTitle: metadata.windowTitle,
        pageTitle: metadata.pageTitle,
        url: metadata.url,
        keyboardActivity: metadata.keyboardActivity,
        mouseActivity: metadata.mouseActivity,
        appSwitchCount: metadata.appSwitchCount,
        gitBranch: metadata.gitBranch,
        gitDirty: metadata.gitDirty,
        manualNote: null,
        status: 'captured',
        excludedReason: null,
        metadataJson: metadata.metadataJson,
        checkpointId: null,
      };

      this.db.insertSnapshot(snapshot);
      this.lastCaptureAt = capturedAt;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to capture screenshot';
      this.lastError = message;
      this.db.insertError('capture', message, error instanceof Error ? error.stack : null);
    }
  }

  private async analyzeReadyWindows(force = false): Promise<void> {
    if (this.isSuspended) {
      return;
    }
    if (this.isAnalyzing) {
      return;
    }
    if (!this.settings.isTracking && !force) {
      return;
    }
    if (!force && Date.now() < this.analyzeSuppressedUntil) {
      return;
    }

    this.isAnalyzing = true;

    try {
      const windows = this.db.getReadySnapshotWindows(
        this.settings.checkIntervalMinutes,
        force ? dayjs().add(this.settings.checkIntervalMinutes, 'minute').toISOString() : new Date().toISOString(),
      );

      for (const windowSnapshots of windows) {
        if (!windowSnapshots.length) {
          continue;
        }

        const attempts = this.db.getAnalysisAttempts(windowSnapshots.map((snapshot) => snapshot.id));
        if (attempts >= this.settings.maxAnalysisRetries) {
          continue;
        }

        try {
          let checkpoint: import('../../shared/types.js').CheckpointRecord;
          if (this.isIdleWindow(windowSnapshots)) {
            checkpoint = this.createIdleCheckpoint(windowSnapshots);
          } else {
            const previous = this.db.getLastCheckpoint();
            checkpoint = await analyzeWindow({
              snapshots: windowSnapshots,
              settings: this.settings,
              locale: this.locale,
              previousCheckpoint: previous,
            });
          }
          this.db.insertCheckpoint(checkpoint);
          this.attachCheckpointToWorkUnit(checkpoint);
          this.db.markSnapshotsProcessed(windowSnapshots.map((snapshot) => snapshot.id), checkpoint.id);
          await deleteScreenshots(windowSnapshots);
          this.lastCheckpointAt = checkpoint.createdAt;
        } catch (error) {
          const err = error instanceof Error ? error : new Error('Failed to analyze snapshot window');
          const message = err.message;
          const stack = err.stack ?? null;
          let kind = 'analysis';
          if (err.name === 'AbortError' || message.includes('aborted')) {
            kind = 'analysis:aborted';
          } else if (/client closing|closing the connection/i.test(message)) {
            kind = 'analysis:runner_unloaded';
          } else if (message.includes('fetch failed') || message.toLowerCase().includes('econnreset')) {
            kind = 'analysis:fetch_failed';
          } else if (/Ollama request failed with 5\d\d.*\(after (\d+)ms/.test(message)) {
            const m = message.match(/\(after (\d+)ms/);
            const dur = m ? Number(m[1]) : 0;
            kind = dur < 30_000 ? 'analysis:http_5xx_quick' : 'analysis:http_5xx_slow';
          }
          this.lastError = message;
          this.db.incrementAnalysisAttempts(windowSnapshots.map((snapshot) => snapshot.id));
          this.db.insertError(kind, message, stack);
        }
      }
    } finally {
      this.isAnalyzing = false;
    }
  }

  private attachCheckpointToWorkUnit(checkpoint: Parameters<typeof createWorkUnitFromCheckpoint>[0]): void {
    if (checkpoint.projectName && !isUnknownLabel(checkpoint.projectName)) {
      const learnedCategory = this.db.getCategoryRule(checkpoint.projectName);
      if (learnedCategory) {
        checkpoint = { ...checkpoint, category: toStoredCategoryLabel(learnedCategory) };
      }
    }

    const current = this.db.getCurrentWorkUnit();
    if (!current) {
      this.db.insertWorkUnit(createWorkUnitFromCheckpoint(checkpoint));
      return;
    }

    if (shouldMergeWorkUnit(current, checkpoint, this.settings)) {
      this.db.updateWorkUnit(mergeCheckpointIntoWorkUnit(current, checkpoint));
      return;
    }

    this.db.insertWorkUnit(createWorkUnitFromCheckpoint(checkpoint));
  }
}
