import type { AppSettings, SnapshotRecord } from '../../shared/types.js';

/**
 * カーソル静止 + 除外アプリ非該当 + （設定有効時）imageHash全一致
 * の3条件すべて満たすときに true を返す。
 */
export function isIdleWindow(snapshots: SnapshotRecord[], settings: AppSettings): boolean {
  if (snapshots.length < 2) {
    return false;
  }

  const excludedApps = (settings.idleExcludedApps ?? []).map((name) => name.toLowerCase()).filter(Boolean);
  if (excludedApps.length > 0) {
    for (const snap of snapshots) {
      const app = snap.activeApp?.toLowerCase().trim();
      if (!app) {
        continue;
      }
      if (excludedApps.some((excluded) => app === excluded || app.includes(excluded))) {
        return false;
      }
    }
  }

  if (settings.idleRequireStableImage) {
    const hashes = snapshots
      .map((s) => s.imageHash)
      .filter((h): h is string => typeof h === 'string' && h.length > 0);
    if (hashes.length >= 2) {
      const first = hashes[0]!;
      if (!hashes.every((h) => h === first)) {
        return false;
      }
    }
  }

  const withCursor = snapshots.filter((s) => s.cursorX !== null && s.cursorY !== null);
  if (withCursor.length < 2) {
    return false;
  }
  const refX = withCursor[0]!.cursorX!;
  const refY = withCursor[0]!.cursorY!;
  return withCursor.every(
    (s) => Math.abs(s.cursorX! - refX) <= 1 && Math.abs(s.cursorY! - refY) <= 1,
  );
}
