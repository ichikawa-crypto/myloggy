import { trimText } from './utils.js';

const TEXT_VALUE_KEYS = ['text', 'value', 'label', 'name', 'title', 'summary', 'content', 'description', 'reason', 'message'] as const;
const NUMERIC_VALUE_KEYS = ['value', 'score', 'confidence', 'number', 'amount'] as const;
const BOOLEAN_VALUE_KEYS = ['value', 'flag', 'enabled', 'checked', 'is_distracted', 'isDistracted', 'distracted'] as const;
const ENVELOPE_KEYS = ['response', 'output', 'result', 'data', 'json', 'content', 'message'] as const;

const FIELD_ALIASES = {
  project_name: ['project_name', 'projectName'] as const,
  task_label: ['task_label', 'taskLabel'] as const,
  state_summary: ['state_summary', 'stateSummary'] as const,
  evidence: ['evidence'] as const,
  continuity: ['continuity'] as const,
  confidence: ['confidence'] as const,
  is_distracted: ['is_distracted', 'isDistracted', 'distracted'] as const,
  category: ['category', 'categoryName', 'カテゴリ'] as const,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parseBooleanString(value: string): boolean | undefined {
  const normalized = trimText(value).toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (['true', 'yes', '1', 'on', 'はい', '真'].includes(normalized)) {
    return true;
  }
  if (['false', 'no', '0', 'off', 'いいえ', '偽'].includes(normalized)) {
    return false;
  }
  return undefined;
}

function collectTextParts(value: unknown, seen = new WeakSet<object>()): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    const normalized = trimText(value);
    return normalized ? [normalized] : [];
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? [String(value)] : [];
  }
  if (typeof value === 'boolean') {
    return [value ? 'true' : 'false'];
  }
  if (Array.isArray(value)) {
    return uniqueStrings(value.flatMap((item) => collectTextParts(item, seen)));
  }
  if (!isRecord(value)) {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const preferred = uniqueStrings(
    TEXT_VALUE_KEYS.flatMap((key) => collectTextParts(value[key], seen)),
  );
  if (preferred.length) {
    return preferred;
  }

  return uniqueStrings(
    Object.values(value).flatMap((item) => collectTextParts(item, seen)),
  );
}

function normalizeTextValue(value: unknown): string | undefined {
  const normalized = uniqueStrings(collectTextParts(value)).join(' / ');
  return normalized || undefined;
}

function collectNumbers(value: unknown, seen = new WeakSet<object>()): number[] {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? [value] : [];
  }
  if (typeof value === 'string') {
    const match = trimText(value).match(/-?\d+(?:\.\d+)?/);
    if (!match) {
      return [];
    }
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? [parsed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectNumbers(item, seen));
  }
  if (!isRecord(value)) {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const preferred = NUMERIC_VALUE_KEYS.flatMap((key) => collectNumbers(value[key], seen));
  if (preferred.length) {
    return preferred;
  }
  return Object.values(value).flatMap((item) => collectNumbers(item, seen));
}

function normalizeNumberValue(value: unknown): number | undefined {
  return collectNumbers(value)[0];
}

function collectBooleans(value: unknown, seen = new WeakSet<object>()): boolean[] {
  if (typeof value === 'boolean') {
    return [value];
  }
  if (typeof value === 'number') {
    return [value !== 0];
  }
  if (typeof value === 'string') {
    const parsed = parseBooleanString(value);
    return parsed === undefined ? [] : [parsed];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectBooleans(item, seen));
  }
  if (!isRecord(value)) {
    return [];
  }
  if (seen.has(value)) {
    return [];
  }
  seen.add(value);

  const preferred = BOOLEAN_VALUE_KEYS.flatMap((key) => collectBooleans(value[key], seen));
  if (preferred.length) {
    return preferred;
  }
  return Object.values(value).flatMap((item) => collectBooleans(item, seen));
}

function normalizeBooleanValue(value: unknown): boolean | undefined {
  return collectBooleans(value)[0];
}

function normalizeContinuityValue(value: unknown): 'continue' | 'switch' | 'unclear' | undefined {
  const text = normalizeTextValue(value)?.toLowerCase();
  if (!text) {
    return undefined;
  }
  if (text.includes('yes') || text.includes('same') || text.includes('継続')) {
    return 'continue';
  }
  if (text.includes('continue') || text.includes('継続')) {
    return 'continue';
  }
  if (text.includes('switch') || text.includes('change') || text.includes('切り替') || text.includes('切替')) {
    return 'switch';
  }
  if (text.includes('unclear') || text.includes('unknown') || text.includes('不明') || text.includes('判断不能')) {
    return 'unclear';
  }
  return undefined;
}

function normalizeEvidenceValue(value: unknown): string[] | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const candidates = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.values(value)
      : [value];
  const normalized = uniqueStrings(candidates.map((item) => normalizeTextValue(item)));
  return normalized.length ? normalized : undefined;
}

function firstAliasValue(record: Record<string, unknown>, aliases: readonly string[]): unknown {
  for (const alias of aliases) {
    if (alias in record) {
      return record[alias];
    }
  }
  return undefined;
}

function hasCheckpointShape(record: Record<string, unknown>): boolean {
  return Object.values(FIELD_ALIASES).some((aliases) => aliases.some((alias) => alias in record));
}

export function extractJsonBlock(content: string): string {
  const trimmed = content.trim();
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');
  const startCandidates = [objectStart, arrayStart].filter((value) => value >= 0);
  if (!startCandidates.length) {
    return trimmed;
  }
  const start = Math.min(...startCandidates);
  const isArray = start === arrayStart && (objectStart === -1 || arrayStart < objectStart);
  const end = isArray ? trimmed.lastIndexOf(']') : trimmed.lastIndexOf('}');
  if (end === -1 || end <= start) {
    return trimmed;
  }
  return trimmed.slice(start, end + 1);
}

function stripCodeFences(content: string): string {
  const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1]!.trim() : content;
}

/** Best-effort repair when the model truncates mid-JSON (common with large vision payloads). */
function lenientJsonParseBlock(block: string): unknown {
  for (let end = block.length; end > 0; end--) {
    try {
      const parsed = JSON.parse(block.slice(0, end));
      if (parsed !== null && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      /* continue */
    }
  }
  const partial = extractPartialStringFields(block);
  return Object.keys(partial).length ? partial : {};
}

function extractPartialStringFields(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = ['project_name', 'task_label', 'state_summary'] as const;
  for (const key of keys) {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`);
    const m = block.match(re);
    if (m?.[1] !== undefined) {
      out[key] = m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  const cont = block.match(/"continuity"\s*:\s*"(continue|switch|unclear)"/);
  if (cont?.[1]) {
    out.continuity = cont[1];
  }
  const conf = block.match(/"confidence"\s*:\s*([0-9.]+)/);
  if (conf?.[1]) {
    out.confidence = Number(conf[1]);
  }
  const distr = block.match(/"is_distracted"\s*:\s*(true|false)/);
  if (distr?.[1]) {
    out.is_distracted = distr[1] === 'true';
  }
  return out;
}

function parseStructuredPayload(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    return raw;
  }
  let trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  trimmed = stripCodeFences(trimmed);
  const block = extractJsonBlock(trimmed);
  try {
    return JSON.parse(block);
  } catch {
    return lenientJsonParseBlock(block);
  }
}

function extractCheckpointCandidate(raw: unknown): Record<string, unknown> {
  const parsed = parseStructuredPayload(raw);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const candidate = extractCheckpointCandidate(item);
      if (Object.keys(candidate).length) {
        return candidate;
      }
    }
    return {};
  }
  if (!isRecord(parsed)) {
    return {};
  }
  if (hasCheckpointShape(parsed)) {
    return parsed;
  }
  for (const key of ENVELOPE_KEYS) {
    if (!(key in parsed)) {
      continue;
    }
    const candidate = extractCheckpointCandidate(parsed[key]);
    if (Object.keys(candidate).length) {
      return candidate;
    }
  }
  return parsed;
}

export function normalizeCheckpointLlmOutput(raw: unknown): Record<string, unknown> {
  const candidate = extractCheckpointCandidate(raw);
  return {
    project_name: normalizeTextValue(firstAliasValue(candidate, FIELD_ALIASES.project_name)),
    task_label: normalizeTextValue(firstAliasValue(candidate, FIELD_ALIASES.task_label)),
    state_summary: normalizeTextValue(firstAliasValue(candidate, FIELD_ALIASES.state_summary)),
    evidence: normalizeEvidenceValue(firstAliasValue(candidate, FIELD_ALIASES.evidence)),
    continuity: normalizeContinuityValue(firstAliasValue(candidate, FIELD_ALIASES.continuity)),
    confidence: normalizeNumberValue(firstAliasValue(candidate, FIELD_ALIASES.confidence)),
    is_distracted: normalizeBooleanValue(firstAliasValue(candidate, FIELD_ALIASES.is_distracted)),
    category: normalizeTextValue(firstAliasValue(candidate, FIELD_ALIASES.category)),
  };
}
