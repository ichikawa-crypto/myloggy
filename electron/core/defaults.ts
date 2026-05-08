import type { AppSettings } from '../../shared/types.js';
import { DEFAULT_CATEGORIES } from '../../shared/localization.js';

/** Long-edge cap (px) for capture JPEG before LLM; `sips -Z` does not upscale smaller images. */
export const CAPTURE_JPEG_MAX_LONG_EDGE_PX = 1920;

/** JPEG quality (1-100) passed to `sips -s formatOptions` when re-encoding after resize. */
export const CAPTURE_JPEG_SIPS_QUALITY = 75;

/** Disable in-place downsample to preserve OCR/UI legibility. Set to true to re-enable. */
export const CAPTURE_JPEG_DOWNSAMPLE_ENABLED = false;

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
