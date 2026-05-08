import fs from 'node:fs/promises';

import { Agent } from 'undici';
import { z } from 'zod';

import {
  UNKNOWN_LABEL,
  CANONICAL_PROJECTS,
  canonicalizeProject,
  localizeInsufficientInfoSummary,
  localizeUnknownTaskLabel,
  type SupportedLocale,
} from '../../shared/localization.js';
import type { AppSettings, CheckpointRecord, SecondaryActivity, SnapshotRecord } from '../../shared/types.js';
import { normalizeCheckpointLlmOutputWithSecondary } from './llm-response.js';
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
/** One frame per logical display keeps multimodal context within model limits (merged across snapshots, newest wins per display index). */
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

/**
 * Prefer the latest snapshot per display index, then emit paths in ascending display order (0, 1, 2 …).
 * Stops after `MAX_VISION_IMAGES` paths.
 */
export function collectVisionImagePaths(snapshots: SnapshotRecord[]): string[] {
  const byDisplay = new Map<number, string>();
  for (let s = snapshots.length - 1; s >= 0; s--) {
    const snapshot = snapshots[s]!;
    const list = snapshot.imagePaths.length ? snapshot.imagePaths : snapshot.imagePath ? [snapshot.imagePath] : [];
    for (let displayIndex = 0; displayIndex < list.length; displayIndex++) {
      const candidate = list[displayIndex];
      const filePath = typeof candidate === 'string' ? trimText(candidate) : '';
      if (!filePath) {
        continue;
      }
      if (!byDisplay.has(displayIndex)) {
        byDisplay.set(displayIndex, filePath);
      }
    }
  }
  const indices = [...byDisplay.keys()].sort((a, b) => a - b);
  const paths: string[] = [];
  for (const i of indices) {
    if (paths.length >= MAX_VISION_IMAGES) {
      break;
    }
    const p = byDisplay.get(i);
    if (p) {
      paths.push(p);
    }
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
    return canonicalizeProject(undefined);
  }
  return canonicalizeProject(t);
}

function applyInsufficientEvidenceTaskLabelPrefix(taskLabel: string, locale: SupportedLocale): string {
  if (taskLabel.startsWith('(根拠不足な)')) {
    return taskLabel;
  }
  if (locale === 'en' && taskLabel.startsWith('(insufficient evidence) ')) {
    return taskLabel;
  }
  return locale === 'ja' ? `(根拠不足な)${taskLabel}` : `(insufficient evidence) ${taskLabel}`;
}

function enrichTaskLabelWithSnapshotMetadata(
  taskLabel: string,
  locale: SupportedLocale,
  snapshot: SnapshotRecord | undefined,
): string {
  if (!snapshot) {
    return taskLabel;
  }
  const trimmed = trimText(taskLabel);
  const unknownPhrase = localizeUnknownTaskLabel(locale);
  const insufficientPrefixed =
    locale === 'ja'
      ? trimmed.startsWith('(根拠不足な)')
      : trimmed.toLowerCase().startsWith('(insufficient evidence)');
  if (trimmed !== unknownPhrase && !insufficientPrefixed) {
    return taskLabel;
  }

  const parts = [snapshot.activeApp, snapshot.windowTitle, snapshot.pageTitle].map((s) => trimText(s ?? '')).filter(Boolean);
  if (!parts.length) {
    return taskLabel;
  }
  const hint = parts.slice(0, 2).join(' · ');
  if (insufficientPrefixed) {
    return sanitizeTaskLabel(`${trimmed} ${hint}`, locale);
  }
  return sanitizeTaskLabel(hint, locale);
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
    project_name: z.string().default('その他'),
    task_label: z.string().default(localizeUnknownTaskLabel(locale)),
    state_summary: z.string().default(localizeInsufficientInfoSummary(locale)),
    evidence: z.array(z.string()).default([locale === 'ja' ? 'メタ情報不足' : 'Insufficient metadata']),
    continuity: z.enum(['continue', 'switch', 'unclear']).default('unclear'),
    confidence: z.union([z.number(), z.string().transform(Number)]).pipe(z.number().min(0).max(1)).default(0.3),
    is_distracted: z.boolean().default(false),
    category: z.string().default(UNKNOWN_LABEL),
  });
}

function createSecondaryActivitySchema(locale: SupportedLocale) {
  const displayIndex = z.preprocess((value) => {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(trimText(value)) : Number.NaN;
    return Number.isFinite(n) ? n : 0;
  }, z.number().int().nonnegative());

  return z.object({
    display_index: displayIndex,
    project_name: z.string().default('その他'),
    task_label: z.string().default(localizeUnknownTaskLabel(locale)),
    state_summary: z.string().default(localizeInsufficientInfoSummary(locale)),
    evidence: z.array(z.string()).default([locale === 'ja' ? 'メタ情報不足' : 'Insufficient metadata']),
    category: z.string().default(UNKNOWN_LABEL),
  });
}

/** Applies the same sanitization as primary checkpoint rows (used by tests). */
export function materializeSecondaryActivities(
  normalizedRows: Record<string, unknown>[],
  settings: AppSettings,
  locale: SupportedLocale,
  metaSnapshot?: SnapshotRecord,
): SecondaryActivity[] {
  const schema = createSecondaryActivitySchema(locale);
  const out: SecondaryActivity[] = [];
  for (const row of normalizedRows) {
    let parsed;
    try {
      parsed = schema.parse(row);
    } catch {
      continue;
    }

    let evidence = sanitizeEvidence(parsed.evidence, locale);
    let taskLabel = sanitizeTaskLabel(parsed.task_label, locale);
    if (evidence.length < 3) {
      taskLabel = applyInsufficientEvidenceTaskLabelPrefix(taskLabel, locale);
    }
    taskLabel = enrichTaskLabelWithSnapshotMetadata(taskLabel, locale, metaSnapshot);

    out.push({
      displayIndex: parsed.display_index,
      projectName: sanitizeProjectName(trimText(parsed.project_name)),
      category: sanitizeCategory(parsed.category, settings),
      taskLabel,
      stateSummary: sanitizeSummary(parsed.state_summary, locale),
      evidence,
    });
  }
  return out;
}

function buildPrompt(
  snapshots: SnapshotRecord[],
  settings: AppSettings,
  previousCheckpoint: CheckpointRecord | null,
  locale: SupportedLocale,
): string {
  const canonicalProjectsLine = CANONICAL_PROJECTS.join('、');
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
過剰推測は禁止。画像とメタデータの事実を優先する。分からない時は無理に詳細化せず、task_label / state_summary に正直に書く。

## プロジェクト名（必須・5値のうちいずれか）
以下のいずれかを必ず使用してください（完全一致・このリストのみ）: ${canonicalProjectsLine}
- 「タビケン留学」: 留学エージェント業務（旧称: TF/タビケン）
- 「イングリード」: 英語コーチング事業（旧称: ENGLEAD/EL）
- 「アルボナ」: Albona関連（myloggy開発含む）
- 「マーケ全社」: 横断マーケティング・経営全般（Morrow World 等）
- 「その他」: 上記に該当しない・判定できない作業

プロジェクト判定の手がかり:
- URLが docs.google.com の場合 → ファイル名・シート名から推測
- Slack: ワークスペース名・チャネル名（"#101-留学..." → タビケン留学、"#11-EL-..." → イングリード等）
- エディタ: ファイルパス・リポジトリ名
- 不明確な場合は「その他」を選び無理に推測しない

【利用者プロファイル・追加ヒント】
- englead.jp / FC顧客リスト → イングリード
- tabiken-ryugaku / TF・TR Notion → タビケン留学
- ~/myloggy / Albona / 該当GitHub repo → アルボナ
- Meta/Google/TikTok/Microsoft Ads・タビケン記事・リール素材は、どの事業ドメインかで上記5値へ割当

複数候補があるなら最も時間配分が長そうな軸を1つだけ選ぶ。

【カテゴリ判定基準】（必ず以下から1つだけ選んで category に入れる）
- 開発: Cursor/Claude Code でコード編集、ターミナル作業、エンジニアリング
- 調査・情報収集: ブラウザでドキュメント・記事閲覧、ChatGPT壁打ち、競合調査、市場調査
- 事務作業: スプシ集計、CRM入力、メール処理、書類作成、Notion更新、Slackで業務連絡
- 打ち合わせ: GoogleMeet/Zoom が起動中、カレンダーイベント中、議事録記録
- 休憩: アイドル状態、明確に作業から離れている
- サボり: SNS閲覧、ニュースサイト、ECサイト、無関係動画など、業務と無関係な閲覧

## task_label（必須・15〜30文字目安）
「<対象の固有名詞> + <具体的な行為>」の形式で書く。
- 良い例: "顧客管理シートのCPA列計算", "Slack #11-EL-運用ch でチャネル戦略議論", "myloggy llm.ts のプロンプト編集"
- 悪い例: "スプレッドシート作業", "事務作業", "コーディング"
- 対象が画面から特定できない時は「(対象不明な)<行為>」と書く（無理に作らない）

## state_summary（必須・40〜80文字目安、最大160文字）
task_labelより詳細に「何のために何をどう進めているか」を1文で述べる。evidence配列で使った語彙（固有名詞）を必ず再利用する。「分からない時は無理に詳細化しない」——曖昧なら短く正直に書く。

${previousBlock}

観測サンプル（時系列）:
${snapshotLines.join('\n\n')}

## マルチディスプレイ判定（重要）
複数モニタ時、添付画像は先頭から順に display 0, display 1, display 2 … に対応します。
ユーザーはモニタごとに別作業を並行している可能性があります。

一次集計（ワークユニット）の対象は primary のみです。他モニタで明確に異なる実作業がある場合のみ secondary に追記します。

### 推奨レスポンスJSON形
{
  "primary": {
    "project_name": "（5値のいずれか）",
    "category": "（上記カテゴリ一覧のいずれか）",
    "task_label": "...",
    "state_summary": "...",
    "evidence": ["...", "...", "..."],
    "continuity": "continue|switch|unclear",
    "confidence": 0.0,
    "is_distracted": false,
    "display_index": 0
  },
  "secondary": [
    {
      "display_index": 1,
      "project_name": "...",
      "category": "...",
      "task_label": "...",
      "state_summary": "...",
      "evidence": ["...", "...", "..."]
    }
  ]
}

### primary の選定
- cursor_display_index が分かるときはそのモニタ優先
- 最も具体的な作業が読み取れるモニタ
- 不明なら display 0

### secondary に入れる条件（0〜2件目安）
- primary と project_name または task_label の対象が明確に違うときだけ
- 参照用のブラウザ・通知だけ・「見ているだけ」は除外
- 同一スプレッドシートのコピペ連動など、一本の作業の延長は除外
- 各要素も evidence は **3件以上**、project_name は **5値のみ**、category は上記マスタに合わせる

### 後方互換
単一モニタや旧モデルではトップレベルに従来どおり project_name, task_label, … を置いてもよい（secondary は省略可）。

厳守:
- 応答はJSONオブジェクト1つだけ。説明文・マークダウン・コードフェンス禁止。
- 文字列はダブルクォートのみ。改行は \\n でエスケープ。
- state_summary は最大160文字。観測にない事実は書かない。固有名詞は evidence / window_title / url と整合させる。
- primary の evidence は **必ず3件以上、最大6件**。各60文字以内。抽象的な一文は禁止; 観測サンプル由来の語を必ず含める。
- ラッパー形のとき primary に continuity, confidence, is_distracted, category を含める。secondary 各要素にも category / evidence（3件以上）を含める。
- 単一オブジェクト形のとき、キーは従来どおり: project_name, task_label, state_summary, evidence, continuity, confidence, is_distracted, category
- continuity は continue / switch / unclear のみ。confidence は 0.0〜1.0。
- category は次のいずれかの文字列のみ: ${categoryList}（不明なら "不明"）
- project_name は上記5値のみ（不明瞭なら「その他」）。
- 脱線なら is_distracted を true。

## Few-shot 良い例
{
  "project_name": "タビケン留学",
  "category": "事務作業",
  "task_label": "顧客管理シート 4月CPA列の数式修正",
  "state_summary": "GoogleスプレッドシートでタビケンFC顧客リストの4月CPA計算式を確認しIF関数で再構築している",
  "evidence": ["URL: docs.google.com/spreadsheets/d/.../edit", "シート名: '4月_CPA計算'", "数式バーに =IF(...)"]
}

分からない時の例:
{
  "project_name": "その他",
  "category": "不明",
  "task_label": "(対象不明な)Webブラウジング",
  "state_summary": "ブラウザで複数タブを切り替えており具体的な作業対象は判別できない",
  "evidence": ["Chrome active", "複数タブ切替検出", "タイトルが多様"]
}

モデル: ${settings.llmModel}
`;
  }

  return `
You are the classifier for a local work log app.
Identify exactly one primary work activity from the observation samples below.
Do not over-infer; prioritize image and metadata facts. When uncertain, do not fabricate detail—state that honestly.

## project_name (required — exactly one of these strings)
You MUST set project_name to exactly one of: ${canonicalProjectsLine}
- タビケン留学: study-abroad agency work (legacy: TF/Tabiken)
- イングリード: English coaching business (legacy: ENGLEAD/EL)
- アルボナ: Albona / myloggy development and related
- マーケ全社: cross-cutting marketing and company-wide strategy (e.g. Morrow World)
- その他: none of the above or cannot determine

Hints: docs.google.com → infer from file/sheet names; Slack → channel names; editors → paths/repos. If unclear, use その他—do not guess.

${previousBlock}

## task_label (required, ~15–30 chars)
Format: "<specific object/name> + <concrete action>".
Good: "顧客管理シートのCPA列計算", "Slack #11-EL-運用ch でチャネル戦略議論", "myloggy llm.ts のプロンプト編集"
Bad: "スプレッドシート作業", "事務作業", "コーディング"
If the target cannot be identified: "(対象不明な)<action>" without inventing names.

## state_summary (required, ~40–80 chars target, max 160)
One sentence: why/what/how. Reuse vocabulary from evidence. If detail is uncertain, keep it short and honest.

Observation samples (time-ordered):
${snapshotLines.join('\n\n')}

## Multi-monitor analysis (important)
When multiple images are provided, they correspond in order to display 0, display 1, display 2 …
The user may be doing different substantive work on different screens.
Only **primary** feeds the main work-unit timeline; put clearly distinct work on other monitors in **secondary**.

### Preferred JSON shape
{
  "primary": {
    "project_name": "(one of the five Japanese canonical names)",
    "category": "(one category from the list below)",
    "task_label": "...",
    "state_summary": "...",
    "evidence": ["...", "...", "..."],
    "continuity": "continue|switch|unclear",
    "confidence": 0.0,
    "is_distracted": false,
    "display_index": 0
  },
  "secondary": [
    {
      "display_index": 1,
      "project_name": "...",
      "category": "...",
      "task_label": "...",
      "state_summary": "...",
      "evidence": ["...", "...", "..."]
    }
  ]
}

### Choosing primary
- Prefer the monitor indicated by cursor_display_index in metadata when credible
- Otherwise the monitor showing the most concrete active work
- If unclear, assume display 0

### Secondary rules (typically 0–2 items)
- Only when project_name OR task_label target clearly differs from primary
- Exclude passive/reference-only browser panels, stray notifications, or “just watching”
- Exclude tightly coupled continuity (same spreadsheet paste flow counts as one task)
- Each secondary item MUST also use the five canonical project names, MUST include **at least three** concrete evidence strings, and reuse allowed categories only

### Backward compatibility
For a single screen or legacy models you may omit the wrapper and emit the flat JSON with project_name, task_label, … at the top level; omit secondary if unused.

Strict rules:
- Return a single JSON object only. No markdown, no code fences, no commentary.
- Use double quotes for strings. Escape newlines as \\n.
- state_summary max 160 characters; no facts not grounded in observations; align proper nouns with evidence and metadata.
- **primary.evidence** MUST have **at least 3 items, up to 6**, each within 60 characters, each citing something concrete from the samples. No vague filler.
- In wrapper form, secondary entries follow the same evidence / project_name rules.
- continuity is one of continue / switch / unclear. confidence is 0.0 to 1.0.
- category must be exactly one of: ${settings.categories.join(', ')} (use "Unknown" only if undetermined).
- project_name must be one of the five Japanese strings above (use その他 when unclear).
- Set is_distracted true only for clear off-task distraction.

## Few-shot (good)
{
  "project_name": "タビケン留学",
  "category": "事務作業",
  "task_label": "顧客管理シート 4月CPA列の数式修正",
  "state_summary": "GoogleスプレッドシートでタビケンFC顧客リストの4月CPA計算式を確認しIF関数で再構築している",
  "evidence": ["URL: docs.google.com/spreadsheets/d/.../edit", "シート名: '4月_CPA計算'", "数式バーに =IF(...)"]
}

## Few-shot (uncertain)
{
  "project_name": "その他",
  "category": "不明",
  "task_label": "(対象不明な)Webブラウジング",
  "state_summary": "ブラウザで複数タブを切り替えており具体的な作業対象は判別できない",
  "evidence": ["Chrome active", "複数タブ切替検出", "タイトルが多様"]
}

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
    const normalized = normalizeCheckpointLlmOutputWithSecondary(data);
    const parsed = createCheckpointSchema(locale).parse(normalized.primary);

    const evidence = sanitizeEvidence(parsed.evidence, locale);
    let taskLabel = sanitizeTaskLabel(parsed.task_label, locale);
    if (evidence.length < 3) {
      taskLabel = applyInsufficientEvidenceTaskLabelPrefix(taskLabel, locale);
    }

    const latestSnapshot = forLlm.at(-1);
    taskLabel = enrichTaskLabelWithSnapshotMetadata(taskLabel, locale, latestSnapshot);

    const secondaryActivities = materializeSecondaryActivities(normalized.secondary, settings, locale, latestSnapshot);

    const startAt = snapshots[0]?.capturedAt ?? new Date().toISOString();
    const endAt = snapshots.at(-1)?.capturedAt ?? startAt;
    const appSummary = [...new Set(snapshots.map((item) => trimText(item.activeApp)).filter(Boolean))];
    const urlSummary = [...new Set(snapshots.map((item) => trimText(item.url)).filter(Boolean))];

    return {
      id: createId('cp'),
      startAt,
      endAt,
      projectName: sanitizeProjectName(trimText(parsed.project_name)),
      taskLabel,
      category: sanitizeCategory(parsed.category, settings),
      stateSummary: sanitizeSummary(parsed.state_summary, locale),
      evidence,
      continuity: parsed.continuity,
      confidence: parsed.confidence,
      sourceSnapshotIds: snapshots.map((snapshot) => snapshot.id),
      llmModel: settings.llmModel,
      createdAt: new Date().toISOString(),
      isDistracted: parsed.is_distracted,
      status: 'completed',
      appSummary,
      urlSummary,
      secondaryActivities,
    };
  } finally {
    clearTimeout(timeout);
  }
}
