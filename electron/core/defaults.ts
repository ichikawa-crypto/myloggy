import type { AppSettings } from '../../shared/types.js';
import { DEFAULT_CATEGORIES } from '../../shared/localization.js';

/** Long-edge cap (px) for capture JPEG before LLM; `sips -Z` does not upscale smaller images. */
export const CAPTURE_JPEG_MAX_LONG_EDGE_PX = 1920;

/** JPEG quality (1-100) passed to `sips -s formatOptions` when re-encoding after resize. */
export const CAPTURE_JPEG_SIPS_QUALITY = 75;

/** Disable in-place downsample to preserve OCR/UI legibility. Set to true to re-enable. */
export const CAPTURE_JPEG_DOWNSAMPLE_ENABLED = false;

/** Rows in `snapshots` older than this (days, by `captured_at`) are deleted when not linked to a checkpoint. */
export const SNAPSHOT_TTL_DAYS = 30;

/** Rows in `error_logs` older than this (`created_at`) are deleted. */
export const ERROR_LOG_TTL_DAYS = 14;

/** `temp-snaps/*.jpg` with mtime older than this many days are deleted on cleanup. */
export const TEMP_SNAPS_TTL_DAYS = 7;

/** How often `TrackerService` runs DB + temp-snaps cleanup (hours). */
export const CLEANUP_INTERVAL_HOURS = 24;

export const DEFAULT_SETTINGS: AppSettings = {
  isTracking: true,
  captureIntervalMinutes: 1,
  checkIntervalMinutes: 10,
  llmModel: 'qwen2.5vl:7b',
  ollamaHost: 'http://127.0.0.1:11434',
  displayCaptureMode: 'all',
  excludedApps: [],
  excludedDomains: [],
  excludedTimeBlocks: [],
  excludedCaptureMode: 'skip',
  analysisTimeoutMs: 600000,
  maxAnalysisRetries: 3,
  idleGapMinutes: 20,
  categories: DEFAULT_CATEGORIES,
  onboardingCompleted: false,
  idleExcludedApps: [
    'Cursor',
    'Code',
    'Visual Studio Code',
    'Claude',
    'iTerm2',
    'Terminal',
    'Warp',
    'Ghostty',
    'Alacritty',
    'Hyper',
  ],
  idleRequireStableImage: true,
};
