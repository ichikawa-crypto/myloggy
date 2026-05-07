import type { AppSettings } from '../../shared/types.js';
import { DEFAULT_CATEGORIES } from '../../shared/localization.js';

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
