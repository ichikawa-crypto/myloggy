import type { SupportedLocale } from './localization.js';

export type WorkCategory = string;

export type Continuity = 'continue' | 'switch' | 'unclear';

export type SnapshotStatus =
  | 'captured'
  | 'processed'
  | 'analysis_failed'
  | 'analysis_failed_terminal'
  | 'excluded';

export type DisplayCaptureMode = 'main' | 'all';

export interface SnapshotRecord {
  id: string;
  capturedAt: string;
  imagePath: string | null;
  imageHash: string | null;
  imagePaths: string[];
  imageHashes: string[];
  displayCount: number;
  cursorX: number | null;
  cursorY: number | null;
  cursorDisplayId: number | null;
  cursorDisplayIndex: number | null;
  cursorRelativeX: number | null;
  cursorRelativeY: number | null;
  activeApp: string | null;
  windowTitle: string | null;
  pageTitle: string | null;
  url: string | null;
  keyboardActivity: number | null;
  mouseActivity: number | null;
  appSwitchCount: number | null;
  gitBranch: string | null;
  gitDirty: boolean | null;
  manualNote: string | null;
  status: SnapshotStatus;
  excludedReason: string | null;
  metadataJson: string | null;
  checkpointId: string | null;
}

export interface CheckpointRecord {
  id: string;
  startAt: string;
  endAt: string;
  projectName: string;
  taskLabel: string;
  category: WorkCategory;
  stateSummary: string;
  evidence: string[];
  continuity: Continuity;
  confidence: number;
  sourceSnapshotIds: string[];
  llmModel: string;
  createdAt: string;
  isDistracted: boolean;
  status: 'completed' | 'failed';
  appSummary: string[];
  urlSummary: string[];
}

export interface WorkUnitRecord {
  id: string;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  projectName: string;
  title: string;
  category: WorkCategory;
  summary: string;
  progressLevel: '低' | '中' | '高';
  isDistracted: boolean;
  checkpointIds: string[];
  userEdited: boolean;
  updatedAt: string;
  note: string | null;
}

export interface AppState {
  isTracking: boolean;
  isAnalyzing: boolean;
  pendingSnapshots: number;
  pendingWindows: number;
  lastCaptureAt: string | null;
  lastCheckpointAt: string | null;
  lastError: string | null;
  currentWorkUnit: WorkUnitRecord | null;
}

export interface CategorySummary {
  category: WorkCategory;
  minutes: number;
}

export interface ProjectSummary {
  projectName: string;
  minutes: number;
}

export interface DayTimeline {
  date: string;
  units: WorkUnitRecord[];
  checkpoints: CheckpointRecord[];
  totalMinutes: number;
  categorySummary: CategorySummary[];
  projectSummary: ProjectSummary[];
}

export interface WeekTimeline {
  startDate: string;
  endDate: string;
  units: WorkUnitRecord[];
  totalMinutes: number;
  categorySummary: CategorySummary[];
  projectSummary: ProjectSummary[];
  distractedCount: number;
  longestUnits: WorkUnitRecord[];
}

export interface MonthDaySummary {
  date: string;
  totalMinutes: number;
  representativeUnit: WorkUnitRecord | null;
}

export interface MonthTimeline {
  month: string;
  days: MonthDaySummary[];
  categorySummary: CategorySummary[];
  projectSummary: ProjectSummary[];
  comment: string;
}

export interface DashboardData {
  state: AppState;
  today: DayTimeline;
  week: WeekTimeline;
  month: MonthTimeline;
  recentUnits: WorkUnitRecord[];
  errors: ErrorLogRecord[];
}

export type ExcludedCaptureMode = 'skip' | 'log_only';

export interface TimeBlock {
  start: string;
  end: string;
}

export interface AppSettings {
  isTracking: boolean;
  captureIntervalMinutes: number;
  checkIntervalMinutes: number;
  llmModel: string;
  ollamaHost: string;
  displayCaptureMode: DisplayCaptureMode;
  language?: SupportedLocale;
  excludedApps: string[];
  excludedDomains: string[];
  excludedTimeBlocks: TimeBlock[];
  excludedCaptureMode: ExcludedCaptureMode;
  analysisTimeoutMs: number;
  maxAnalysisRetries: number;
  idleGapMinutes: number;
  categories: string[];
  onboardingCompleted: boolean;
  idleExcludedApps: string[]; // idle判定から除外するアプリ名（大文字小文字を区別しない部分一致）
  idleRequireStableImage: boolean; // true=ウィンドウ内imageHash全一致を要求、false=従来通り
}

export interface OllamaStatus {
  running: boolean;
  models: string[];
}

export interface ModelCheckResult {
  ok: boolean;
  message: string;
}

export interface DebugSnapshot {
  id: string;
  capturedAt: string;
  activeApp: string | null;
  windowTitle: string | null;
  pageTitle: string | null;
  url: string | null;
  cursorX: number | null;
  cursorY: number | null;
  cursorDisplayIndex: number | null;
  status: SnapshotStatus;
  checkpointId: string | null;
  imagesBase64: string[];
  displayCount: number;
}

export interface DebugData {
  snapshots: DebugSnapshot[];
  errors: ErrorLogRecord[];
}

export interface ErrorLogRecord {
  id: string;
  createdAt: string;
  scope: string;
  message: string;
  detail: string | null;
}

export interface BootstrapPayload {
  locale: SupportedLocale;
  state: AppState;
  settings: AppSettings;
  dashboard: DashboardData;
}

export interface WorkUnitPatch {
  id: string;
  title?: string;
  projectName?: string;
  category?: WorkCategory;
  summary?: string;
  isDistracted?: boolean;
  note?: string | null;
}
