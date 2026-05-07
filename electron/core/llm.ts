import fs from 'node:fs/promises';

import { z } from 'zod';

import {
  UNKNOWN_LABEL,
  localizeInsufficientInfoSummary,
  localizeUnknownTaskLabel,
  toStoredProjectName,
  type SupportedLocale,
} from '../../shared/localization.js';
import type { AppSettings, CheckpointRecord, SnapshotRecord } from '../../shared/types.js';
import { normalizeCheckpointLlmOutput } from './llm-response.js';
import { createId, trimText } from './utils.js';

/** Caps vision payload; full window may contain many per-minute snapshots. */
const MAX_SNAPSHOTS_FOR_LLM = 8;
/** One frame per snapshot (main display) keeps multimodal context within model limits. */
const MAX_VISION_IMAGES = 12;

function pickSnapshotsForLlm(snapshots: SnapshotRecord[]): SnapshotRecord[] {
  if (snapshots.length <= MAX_SNAPSHOTS_FOR_LLM) {
    return [...snapshots];
  }
  const max = MAX_SNAPSHOTS_FOR_LLM;
  const n = snapshots.length;
  const indices = new Set<number>();
  for (let i = 0; i < max; i++) {
    indices.add(Math.floor((i * (n - 1)) / Math.max(max - 1, 1)));
  }
  return [...indices].sort((a, b) => a - b).map((i) => snapshots[i]!);
}

function collectVisionImagePaths(snapshots: SnapshotRecord[]): string[] {
  const paths: string[] = [];
  for (const snapshot of snapshots) {
    const list = snapshot.imagePaths.length ? snapshot.imagePaths : snapshot.imagePath ? [snapshot.imagePath] : [];
    const primary = list[0];
    if (!primary) {
      continue;
    }
    if (paths.length >= MAX_VISION_IMAGES) {
      return paths;
    }
    paths.push(primary);
  }
  return paths;
}

/** Same token repeated 4+ times, separated by _ - . / | or whitespace; tokens are Unicode letters/digits. */
const RE_TOKEN_REPEAT_LONG = /([\p{L}\p{N}]{2,})(?:[_\-\s./|]+\1){3,}/iu;
/** As above, but allow 1–3 character tokens (e.g. single-letter or short codes). */
const RE_TOKEN_REPEAT_SHORT = /([\p{L}\p{N}]{1,3})(?:[_\-\s./|]+\1){3,}/iu;

function hasHighlyRepeatedSubstring(text: string): boolean {
  const n = text.length;
  if (n < 8) {
    return false;
  }
  const maxLen = Math.min(200, n - 2);
  if (maxLen < 5) {
    return false;
  }
  for (let len = 5; len <= maxLen; len++) {
    const counts = new Map<string, number>();
    for (let i = 0; i <= n - len; i++) {
      const sub = text.slice(i, i + len);
      const next = (counts.get(sub) ?? 0) + 1;
      if (next >= 3) {
        return true;
      }
      counts.set(sub, next);
    }
  }
  return false;
}

export function looksDegenerateModelText(text: string): boolean {
  const t = trimText(text);
  if (!t) {
    return true;
  }
  const lower = t.toLowerCase();
  if (/unknown-unknown-unknown/.test(lower)) {
    return true;
  }
  const unknownHits = lower.match(/unknown/g)?.length ?? 0;
  if (unknownHits >= 8) {
    return true;
  }
  if (/(\b\w{2,}\b)\s*(?:\|\s*\1\b\s*){4,}/i.test(t)) {
    return true;
  }
  if (RE_TOKEN_REPEAT_LONG.test(t) || RE_TOKEN_REPEAT_SHORT.test(t)) {
    return true;
  }
  if (hasHighlyRepeatedSubstring(t)) {
    return true;
  }
  return false;
}

function sanitizeSummary(text: string, locale: SupportedLocale): string {
  const t = trimText(text);
  if (!t || looksDegenerateModelText(t)) {
    return localizeInsufficientInfoSummary(locale);
  }
  return t.length > 500 ? `${t.slice(0, 497)}…` : t;
}

function sanitizeTaskLabel(text: string, locale: SupportedLocale): string {
  const t = trimText(text);
  if (!t || looksDegenerateModelText(t)) {
    return localizeUnknownTaskLabel(locale);
  }
  return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}

function sanitizeEvidence(items: string[], locale: SupportedLocale): string[] {
  const fallback = locale === 'ja' ? 'メタ情報不足' : 'Insufficient metadata';
  const cleaned = items.map(trimText).filter(Boolean).filter((line) => !looksDegenerateModelText(line));
  const out = cleaned.length ? cleaned : [fallback];
  return out.slice(0, 8);
}

function sanitizeProjectName(raw: string): string {
  const t = trimText(raw);
  if (!t || looksDegenerateModelText(t)) {
    return UNKNOWN_LABEL;
  }
  return toStoredProjectName(t);
}

async function readImagesBase64(paths: string[]): Promise<string[]> {
  const images: string[] = [];
  for (const filePath of paths) {
    try {
      await fs.access(filePath);
      images.push((await fs.readFile(filePath)).toString('base64'));
    } catch {
      throw new Error(`Snapshot image missing or unreadable: ${filePath}`);
    }
  }
  return images;
}

function createCheckpointSchema(locale: SupportedLocale) {
  return z.object({
    project_name: z.string().default(locale === 'ja' ? UNKNOWN_LABEL : 'Unknown'),
    task_label: z.string().default(localizeUnknownTaskLabel(locale)),
    state_summary: z.string().default(localizeInsufficientInfoSummary(locale)),
    evidence: z.array(z.string()).default([locale === 'ja' ? 'メタ情報不足' : 'Insufficient metadata']),
    continuity: z.enum(['continue', 'switch', 'unclear']).default('unclear'),
    confidence: z.union([z.number(), z.string().transform(Number)]).pipe(z.number().min(0).max(1)).default(0.3),
    is_distracted: z.boolean().default(false),
  });
}

function buildPrompt(
  snapshots: SnapshotRecord[],
  settings: AppSettings,
  previousCheckpoint: CheckpointRecord | null,
  locale: SupportedLocale,
): string {
  const snapshotLines = snapshots.map((snapshot, index) => {
    return [
      `snapshot_${index + 1}:`,
      `captured_at=${snapshot.capturedAt}`,
      `active_app=${snapshot.activeApp ?? 'unknown'}`,
      `window_title=${snapshot.windowTitle ?? 'unknown'}`,
      `page_title=${snapshot.pageTitle ?? 'unknown'}`,
      `url=${snapshot.url ?? 'unknown'}`,
      `cursor_display_index=${snapshot.cursorDisplayIndex ?? 'unknown'}`,
      `cursor_relative=${snapshot.cursorRelativeX ?? 'unknown'},${snapshot.cursorRelativeY ?? 'unknown'}`,
      `metadata=${snapshot.metadataJson ?? '{}'}`,
    ].join('\n');
  });

  const previousBlock = previousCheckpoint
    ? locale === 'ja'
      ? `
previous_checkpoint:
project_name=${previousCheckpoint.projectName}
task_label=${previousCheckpoint.taskLabel}
state_summary=${previousCheckpoint.stateSummary}
continuity=${previousCheckpoint.continuity}
`
      : `
previous_checkpoint:
project_name=${previousCheckpoint.projectName}
task_label=${previousCheckpoint.taskLabel}
state_summary=${previousCheckpoint.stateSummary}
continuity=${previousCheckpoint.continuity}
`
    : locale === 'ja'
      ? 'previous_checkpoint: none'
      : 'previous_checkpoint: none';

  if (locale === 'ja') {
    return `
あなたはローカル作業ログアプリの分類器です。
目的は「提示された観測サンプルから、主作業を1つだけ分類すること」です。
過剰推測は禁止。画像とメタデータの事実を優先する。

${previousBlock}

観測サンプル（時系列）:
${snapshotLines.join('\n\n')}

厳守:
- 応答はJSONオブジェクト1つだけ。説明文・マークダウン・コードフェンス禁止。
- 文字列はダブルクォートのみ。改行は \\n でエスケープ。
- state_summary は120文字以内。evidence は各60文字以内、2〜6件。
- キー: project_name, task_label, state_summary, evidence, continuity, confidence, is_distracted
- continuity は continue / switch / unclear のみ。confidence は 0.0〜1.0。
- project_name が不明なら "不明"。脱線なら is_distracted を true。

モデル: ${settings.llmModel}
`;
  }

  return `
You are the classifier for a local work log app.
Identify exactly one primary work activity from the observation samples below.
Do not over-infer; prioritize image and metadata facts.

${previousBlock}

Observation samples (time-ordered):
${snapshotLines.join('\n\n')}

Strict rules:
- Return a single JSON object only. No markdown, no code fences, no commentary.
- Use double quotes for strings. Escape newlines as \\n.
- Keep state_summary within 120 characters. Each evidence line within 60 characters; 2 to 6 items.
- Keys: project_name, task_label, state_summary, evidence, continuity, confidence, is_distracted
- continuity is one of continue / switch / unclear. confidence is 0.0 to 1.0.
- Use "Unknown" for project_name when unclear. Set is_distracted true only for clear off-task distraction.

Model: ${settings.llmModel}
`;
}

export async function analyzeWindow(params: {
  snapshots: SnapshotRecord[];
  settings: AppSettings;
  locale: SupportedLocale;
  previousCheckpoint: CheckpointRecord | null;
}): Promise<CheckpointRecord> {
  const { snapshots, settings, locale, previousCheckpoint } = params;
  const forLlm = pickSnapshotsForLlm(snapshots);
  const prompt = buildPrompt(forLlm, settings, previousCheckpoint, locale);
  const imagePaths = collectVisionImagePaths(forLlm);
  const images = await readImagesBase64(imagePaths);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.analysisTimeoutMs);

  try {
    const response = await fetch(`${settings.ollamaHost}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: settings.llmModel,
        prompt,
        stream: false,
        format: 'json',
        options: {
          temperature: 0.05,
          repeat_penalty: 1.28,
          num_predict: 768,
        },
        images,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed with ${response.status}`);
    }

    const data = await response.json();
    const parsed = createCheckpointSchema(locale).parse(normalizeCheckpointLlmOutput(data));

    const startAt = snapshots[0]?.capturedAt ?? new Date().toISOString();
    const endAt = snapshots.at(-1)?.capturedAt ?? startAt;
    const appSummary = [...new Set(snapshots.map((item) => trimText(item.activeApp)).filter(Boolean))];
    const urlSummary = [...new Set(snapshots.map((item) => trimText(item.url)).filter(Boolean))];

    return {
      id: createId('cp'),
      startAt,
      endAt,
      projectName: sanitizeProjectName(trimText(parsed.project_name)),
      taskLabel: sanitizeTaskLabel(parsed.task_label, locale),
      category: UNKNOWN_LABEL,
      stateSummary: sanitizeSummary(parsed.state_summary, locale),
      evidence: sanitizeEvidence(parsed.evidence, locale),
      continuity: parsed.continuity,
      confidence: parsed.confidence,
      sourceSnapshotIds: snapshots.map((snapshot) => snapshot.id),
      llmModel: settings.llmModel,
      createdAt: new Date().toISOString(),
      isDistracted: parsed.is_distracted,
      status: 'completed',
      appSummary,
      urlSummary,
    };
  } finally {
    clearTimeout(timeout);
  }
}
