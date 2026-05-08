export type SupportedLocale = 'ja' | 'en';

type LocalizedLabel = Record<SupportedLocale, string>;
type KnownCategoryId = 'development' | 'research' | 'admin' | 'meeting' | 'break' | 'offTask' | 'unknown' | 'legacyDistracted';

interface CategoryDefinition {
  id: KnownCategoryId;
  stored: string;
  label: LocalizedLabel;
  aliases: string[];
}

export const UNKNOWN_LABEL = '不明';
export const LEGACY_DISTRACTED_LABEL = '脱線';

export const CANONICAL_PROJECTS = ['タビケン留学', 'マーケ全社', 'イングリード', 'アルボナ', 'その他'] as const;

export const PROJECT_ALIASES: Record<string, string> = {
  タビケン: 'タビケン留学',
  タビケンフォース: 'タビケン留学',
  TF: 'タビケン留学',
  Albona: 'アルボナ',
  albona: 'アルボナ',
  ENGLEAD: 'イングリード',
  EL: 'イングリード',
  englead: 'イングリード',
  'Morrow World': 'マーケ全社',
  モロー: 'マーケ全社',
  マーケ: 'マーケ全社',
  不明: 'その他',
  Unknown: 'その他',
};

export function canonicalizeProject(raw: string | null | undefined): string {
  if (!raw) {
    return 'その他';
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return 'その他';
  }
  const aliasHit = PROJECT_ALIASES[trimmed];
  if (aliasHit) {
    return aliasHit;
  }
  if ((CANONICAL_PROJECTS as readonly string[]).includes(trimmed)) {
    return trimmed;
  }
  for (const [alias, canon] of Object.entries(PROJECT_ALIASES)) {
    if (trimmed.includes(alias)) {
      return canon;
    }
  }
  for (const canon of CANONICAL_PROJECTS) {
    if (trimmed.includes(canon)) {
      return canon;
    }
  }
  return 'その他';
}

const CATEGORY_DEFINITIONS: CategoryDefinition[] = [
  {
    id: 'development',
    stored: '開発',
    label: { ja: '開発', en: 'Development' },
    aliases: ['development', 'dev', 'coding', 'engineering'],
  },
  {
    id: 'research',
    stored: '調査・情報収集',
    label: { ja: '調査・情報収集', en: 'Research' },
    aliases: ['research', 'investigation', 'info gathering', 'information gathering'],
  },
  {
    id: 'admin',
    stored: '事務作業',
    label: { ja: '事務作業', en: 'Admin' },
    aliases: ['admin', 'administration', 'ops', 'operations', 'paperwork'],
  },
  {
    id: 'meeting',
    stored: '打ち合わせ',
    label: { ja: '打ち合わせ', en: 'Meeting' },
    aliases: ['meeting', 'meetings', 'sync', 'call'],
  },
  {
    id: 'break',
    stored: '休憩',
    label: { ja: '休憩', en: 'Break' },
    aliases: ['break', 'rest'],
  },
  {
    id: 'offTask',
    stored: 'サボり',
    label: { ja: 'サボり', en: 'Off-task' },
    aliases: ['off-task', 'off task', 'slacking'],
  },
  {
    id: 'unknown',
    stored: UNKNOWN_LABEL,
    label: { ja: UNKNOWN_LABEL, en: 'Unknown' },
    aliases: ['unknown'],
  },
  {
    id: 'legacyDistracted',
    stored: LEGACY_DISTRACTED_LABEL,
    label: { ja: LEGACY_DISTRACTED_LABEL, en: 'Distracted' },
    aliases: ['distracted'],
  },
];

export const DEFAULT_CATEGORIES = CATEGORY_DEFINITIONS
  .filter((definition) => !['unknown', 'legacyDistracted'].includes(definition.id))
  .map((definition) => definition.stored);

export function isSupportedLocale(value: string | null | undefined): value is SupportedLocale {
  return value === 'ja' || value === 'en';
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

const categoryLookup = new Map<string, CategoryDefinition>();

for (const definition of CATEGORY_DEFINITIONS) {
  const candidates = [
    definition.stored,
    definition.label.ja,
    definition.label.en,
    ...definition.aliases,
  ];
  for (const candidate of candidates) {
    categoryLookup.set(normalizeText(candidate), definition);
  }
}

function findCategoryDefinition(value: string | null | undefined): CategoryDefinition | null {
  const normalized = normalizeText(value ?? '');
  return categoryLookup.get(normalized) ?? null;
}

export function normalizeLocale(value: string | null | undefined): SupportedLocale {
  return /^ja(?:[-_]|$)/i.test((value ?? '').trim()) ? 'ja' : 'en';
}

export function resolveLocalePreference(value: string | null | undefined, fallback: string | null | undefined): SupportedLocale {
  return isSupportedLocale(value) ? value : normalizeLocale(fallback);
}

export function isUnknownLabel(value: string | null | undefined): boolean {
  return findCategoryDefinition(value)?.id === 'unknown';
}

export function localizeCategoryLabel(category: string, locale: SupportedLocale): string {
  return findCategoryDefinition(category)?.label[locale] ?? category;
}

export function toStoredCategoryLabel(category: string): string {
  const trimmed = category.trim();
  if (!trimmed) {
    return trimmed;
  }
  return findCategoryDefinition(trimmed)?.stored ?? trimmed;
}

export function localizeUnknownLabel(locale: SupportedLocale): string {
  return locale === 'ja' ? UNKNOWN_LABEL : 'Unknown';
}

export function localizeProjectName(projectName: string | null | undefined, locale: SupportedLocale): string {
  return isUnknownLabel(projectName) ? localizeUnknownLabel(locale) : projectName?.trim() || localizeUnknownLabel(locale);
}

export function toStoredProjectName(projectName: string | null | undefined): string {
  const trimmed = projectName?.trim() ?? '';
  if (!trimmed || isUnknownLabel(trimmed)) {
    return UNKNOWN_LABEL;
  }
  return trimmed;
}

export function localizeUnknownTaskLabel(locale: SupportedLocale): string {
  return locale === 'ja' ? '状況不明' : 'Unknown task';
}

export function localizeInsufficientInfoSummary(locale: SupportedLocale): string {
  return locale === 'ja'
    ? '判定できる情報が不足している。'
    : 'Not enough information was available to classify the work.';
}

export function localizeIdleTaskLabel(locale: SupportedLocale): string {
  return locale === 'ja' ? '操作なし' : 'No activity';
}

export function localizeIdleSummary(locale: SupportedLocale): string {
  return locale === 'ja'
    ? 'カーソルの移動が検出されなかったため、自動的に休憩と判定。'
    : 'No cursor movement was detected, so this window was classified as a break.';
}

export function localizeIdleEvidence(locale: SupportedLocale): string {
  return locale === 'ja'
    ? 'カーソル位置が全スナップショットで同一'
    : 'The cursor stayed in the same position across all snapshots.';
}

function monthLabel(month: string, locale: SupportedLocale): string {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!year || !monthNumber) {
    return month;
  }
  if (locale === 'ja') {
    return `${monthNumber}月`;
  }
  return new Intl.DateTimeFormat('en-US', { month: 'long' }).format(new Date(Date.UTC(year, monthNumber - 1, 1)));
}

export function buildMonthComment(params: {
  locale: SupportedLocale;
  month: string;
  topCategory?: string | null;
  topProject?: string | null;
}): string {
  const { locale, month, topCategory, topProject } = params;
  const readableMonth = monthLabel(month, locale);

  if (!topCategory) {
    return locale === 'ja'
      ? `${readableMonth}はまだ十分な作業ログがありません。`
      : `There is not enough work log data for ${readableMonth} yet.`;
  }

  const categoryLabel = localizeCategoryLabel(topCategory, locale);
  const projectLabel = localizeProjectName(topProject, locale);

  return locale === 'ja'
    ? `${readableMonth}は「${categoryLabel}」が中心で、主な軸は「${projectLabel}」です。`
    : `${readableMonth} focused on ${categoryLabel}, mainly around ${projectLabel}.`;
}

export function localizeSnapshotStatus(status: string, locale: SupportedLocale): string {
  if (locale === 'ja') {
    if (status === 'captured') return '取得済み';
    if (status === 'processed') return '処理済み';
    if (status === 'analysis_failed') return '解析失敗';
    if (status === 'analysis_failed_terminal') return '解析終了（再試行なし）';
    if (status === 'excluded') return '除外';
    return status;
  }
  if (status === 'captured') return 'Captured';
  if (status === 'processed') return 'Processed';
  if (status === 'analysis_failed') return 'Analysis failed';
  if (status === 'analysis_failed_terminal') return 'Analysis abandoned (max retries)';
  if (status === 'excluded') return 'Excluded';
  return status;
}

export function localizeProgressLevel(level: '低' | '中' | '高', locale: SupportedLocale): string {
  if (locale === 'ja') {
    return level;
  }
  if (level === '高') return 'High';
  if (level === '中') return 'Medium';
  return 'Low';
}

export function isLegacyDistractedCategory(category: string | null | undefined): boolean {
  return findCategoryDefinition(category)?.id === 'legacyDistracted';
}
