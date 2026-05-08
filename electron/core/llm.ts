import fs from 'node:fs/promises';

import { Agent } from 'undici';
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

const ollamaDispatcher = new Agent({
  headersTimeout: 600_000,
  bodyTimeout: 600_000,
  connect: { timeout: 30_000 },
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
});

/** Shorter unload delay reduces idle VRAM when myloggy runs continuously (Ollama /api/generate). */
const OLLAMA_KEEP_ALIVE = '30s';

/** Inference context cap; vision tokens for 3 screen captures can exceed 24k, so 16384 is the practical floor. */
const OLLAMA_NUM_CTX = 16384;

/**
 * Serialize every Ollama /api/generate fetch so only one HTTP request runs at a time (ping, retries, and vision inference share one queue).
 * Ping is not on a separate lock: overlapping model warmup and analysis would still load the runner twice; callers rely on their own timeouts.
 */
let ollamaSerialTail: Promise<void> = Promise.resolve();

function runWithOllamaSerial<T>(fn: () => Promise<T>): Promise<T> {
  const task = ollamaSerialTail.then(() => fn());
  ollamaSerialTail = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/** Caps vision payload; full window may contain many per-minute snapshots. */
const MAX_SNAPSHOTS_FOR_LLM = 4;
/** One frame per snapshot (main display) keeps multimodal context within model limits. */
const MAX_VISION_IMAGES = 3;

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

function sanitizeCategory(raw: string, settings: AppSettings): string {
  const t = trimText(raw);
  if (!t || looksDegenerateModelText(t)) {
    return UNKNOWN_LABEL;
  }
  if (settings.categories.includes(t)) {
    return t;
  }
  const matched = settings.categories.find((cat) => t.includes(cat) || cat.includes(t));
  return matched ?? UNKNOWN_LABEL;
}

async function readImagesBase64(paths: string[]): Promise<string[]> {
  const images: string[] = [];
  for (const filePath of paths) {
    try {
      await fs.access(filePath);
      images.push((await fs.readFile(filePath)).toString('base64'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`myloggy: image skipped (missing/unreadable): ${filePath} - ${message}`);
    }
  }
  if (images.length === 0 && paths.length > 0) {
    throw new Error(`All snapshot images missing or unreadable (window size=${paths.length})`);
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
    category: z.string().default(UNKNOWN_LABEL),
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
    const categoryList = settings.categories.join('、');
    return `
あなたはローカル作業ログアプリの分類器です。
目的は「提示された観測サンプルから、主作業を1つだけ分類すること」です。
過剰推測は禁止。画像とメタデータの事実を優先する。

【利用者プロファイル（市川さんの主要プロジェクト・判定ヒント）】
- イングリード（EL）= 英語コーチング事業: englead.jp / engleadcoach* / 「イングリード」/ FC顧客リスト
- タビケン留学（TR/TF）= 留学エージェント事業: tabiken-ryugaku.co.jp / 「タビケン」/ TF・TR の Notion DB
- マーケ全社（MW）= Morrow World 全社: 組織図・全社戦略・経営Notion
- myloggy / Albona = 個人プロジェクト: ~/myloggy / ~/albona / GitHub 該当repo
- 広告運用 = 各広告プラットフォーム: Meta Ads Manager / Google Ads / TikTok Ads / Microsoft Ads
- SEO記事 = 記事執筆・分析: WordPress / ZAQRO BACCA / タビケン記事DB
- リール制作 = ショート動画: Kling / Grok Imagine / Instagram / ChatGPT(GPT Image)
- CRM/事務 = バックオフィス: Salesforce / Jicoo / freee / ChatWork
- AI開発 = 開発環境: Cursor / Claude Code / Anthropic console / OpenAI

URL・アプリ名・ウィンドウタイトルからプロジェクトを推測して project_name に入れる。
複数候補があるなら最も時間配分の長いものを選ぶ。確信が低くても上記の名称を優先採用し、本当に判定不能な時のみ "不明" を返す。

【カテゴリ判定基準】（必ず以下から1つだけ選んで category に入れる）
- 開発: Cursor/Claude Code でコード編集、ターミナル作業、エンジニアリング
- 調査・情報収集: ブラウザでドキュメント・記事閲覧、ChatGPT壁打ち、競合調査、市場調査
- 事務作業: スプシ集計、CRM入力、メール処理、書類作成、Notion更新、Slackで業務連絡
- 打ち合わせ: GoogleMeet/Zoom が起動中、カレンダーイベント中、議事録記録
- 休憩: アイドル状態、明確に作業から離れている
- サボり: SNS閲覧、ニュースサイト、ECサイト、無関係動画など、業務と無関係な閲覧

${previousBlock}

観測サンプル（時系列）:
${snapshotLines.join('\n\n')}

厳守:
- 応答はJSONオブジェクト1つだけ。説明文・マークダウン・コードフェンス禁止。
- 文字列はダブルクォートのみ。改行は \\n でエスケープ。
- state_summary は **160文字以内**。観測サンプルの window_title/url/page_title から **具体的な固有名詞を必ず1つ以上引用** すること（チャンネル名・ファイル名・シート名・URL・特定タイトル等）。「Slackで業務連絡」「ブラウザで作業」のような一般化された表現は禁止。
- evidence は **必ず2件以上、最大6件**。各60文字以内。各項目には観測サンプルから抽出した **具体的な要素**（アプリ名・window_title・URL・page_title の一部・固有名詞）を1つ以上含める。「画面が表示されている」のような抽象記述は禁止。
- キー: project_name, task_label, state_summary, evidence, continuity, confidence, is_distracted, category
- continuity は continue / switch / unclear のみ。confidence は 0.0〜1.0。
- category は次のいずれかの文字列のみ: ${categoryList}（不明なら "不明"）
- project_name は上記プロファイルの名称を優先。それ以外は画面から推測した固有名詞、判定不能なら "不明"。
- task_label は具体的な動作（例: "Slack外部チャンネル確認", "スプシ集計", "Notion議事録更新"）。汎用ラベル（"事務作業"単独）禁止。
- 脱線なら is_distracted を true。

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
- Keep state_summary within **160 characters**. It MUST cite at least one concrete proper noun observed in window_title/url/page_title (channel name, file name, sheet name, URL, specific title). Generic phrases like "communicating on Slack" or "browsing" are prohibited.
- evidence MUST have **at least 2 items, up to 6**, each within 60 characters. Each item MUST reference a concrete element from the observation samples (app name, part of window_title/URL/page_title, specific proper noun). Abstract phrases like "screen is displayed" are prohibited.
- Keys: project_name, task_label, state_summary, evidence, continuity, confidence, is_distracted, category
- continuity is one of continue / switch / unclear. confidence is 0.0 to 1.0.
- category must be exactly one of: ${settings.categories.join(', ')} (use "Unknown" only if undetermined).
- task_label must describe a concrete action (e.g., "Reviewing external Slack channel", "Spreadsheet aggregation"). Generic labels are prohibited.
- Use "Unknown" for project_name when truly unclear. Set is_distracted true only for clear off-task distraction.

Model: ${settings.llmModel}
`;
}

export async function pingOllama(settings: AppSettings, timeoutMs: number = 30_000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await runWithOllamaSerial(() =>
      fetch(`${settings.ollamaHost}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: settings.llmModel,
          prompt: 'ok',
          stream: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          options: { num_predict: 1, num_ctx: 512 },
        }),
        dispatcher: ollamaDispatcher,
      } as Parameters<typeof fetch>[1] & { dispatcher: Agent }),
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

type OllamaCallResult = { response: Response; durationMs: number };

async function callOllamaWithRetry(
  body: string,
  settings: AppSettings,
  signal: AbortSignal,
): Promise<OllamaCallResult> {
  const url = `${settings.ollamaHost}/api/generate`;
  const headers = { 'Content-Type': 'application/json' };
  const QUICK_FAIL_MS = 30_000;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const response = await runWithOllamaSerial(() =>
        fetch(url, {
          method: 'POST',
          headers,
          signal,
          body,
          dispatcher: ollamaDispatcher,
        } as Parameters<typeof fetch>[1] & { dispatcher: Agent }),
      );
      const durationMs = Date.now() - t0;
      if (response.ok) {
        return { response, durationMs };
      }
      if (attempt === 1 && durationMs < QUICK_FAIL_MS) {
        await new Promise((r) => setTimeout(r, 5_000));
        await pingOllama(settings, 30_000);
        continue;
      }
      throw new Error(`Ollama request failed with ${response.status} (after ${durationMs}ms, attempt ${attempt})`);
    } catch (err) {
      const durationMs = Date.now() - t0;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        throw err;
      }
      if (attempt === 1 && durationMs < QUICK_FAIL_MS) {
        await new Promise((r) => setTimeout(r, 5_000));
        await pingOllama(settings, 30_000);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable: callOllamaWithRetry exhausted attempts');
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
    const body = JSON.stringify({
      model: settings.llmModel,
      prompt,
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      format: 'json',
      options: {
        temperature: 0.05,
        repeat_penalty: 1.28,
        num_predict: 768,
        num_ctx: OLLAMA_NUM_CTX,
      },
      images,
    });

    const { response } = await callOllamaWithRetry(body, settings, controller.signal);

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
      category: sanitizeCategory(parsed.category, settings),
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
