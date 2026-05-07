#!/usr/bin/env python3
"""
myloggy → Notion 同期（設計: docs/sync-to-notion-design.md）
依存: Python 標準ライブラリのみ。
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import stat
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote
from zoneinfo import ZoneInfo

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = REPO_ROOT / "data" / "sync.lock"
STATE_PATH = REPO_ROOT / "data" / "sync_state.json"
STATE_BAK_PATH = REPO_ROOT / "data" / "sync_state.json.bak"
ENV_PATH = REPO_ROOT / ".env"
SYNC_HISTORY_PATH = REPO_ROOT / "logs" / "sync-history.log"

SYNC_HISTORY_STAT_KEYS = (
    "delta",
    "l1_added",
    "l1_updated",
    "l2_added",
    "l2_updated",
    "ollama_fail",
    "errors",
)

NOTION_VERSION = "2022-06-28"
JST = ZoneInfo("Asia/Tokyo")
SYNC_KEY_PROP = "同期キー"

# ---------------------------------------------------------------------------
# Notion property names (design §3)
# ---------------------------------------------------------------------------
L1_TITLE = "タイトル"
L1_START = "開始"
L1_END = "終了"
L1_HOURS = "工数h"
L1_CATEGORY = "カテゴリ"
L1_PROJECT = "プロジェクト"
L1_SUMMARY = "サマリー"
L1_USER_EDITED = "ユーザー編集済み"
L1_SYNC_KEY = SYNC_KEY_PROP
L1_CURSOR = "更新カーソル"
L1_LAST_SYNC = "最終同期"

L2_TITLE = "日付"
L2_DATE_PROP = "日付(date)"
L2_SYNC_KEY = SYNC_KEY_PROP
L2_TOTAL_H = "合計工数h"
L2_CAT_BREAKDOWN = "カテゴリ内訳"
L2_TOP_PROJECTS = "主要プロジェクト"
L2_BREAK_H = "休憩時間h"
L2_REL_WORK_LOG = "作業ログ"
L2_IMPRESSION = "所感"
L2_MODEL = "所感モデル"
L2_PROMPT_VER = "所感プロンプトVer"
L2_IMPRESSION_TIME = "所感生成日時"
L2_FINALIZED = "確定済み"
L2_GENERATED_AT = "生成日時"

CATEGORY_PRESETS = frozenset(
    {
        "広告運用",
        "SEO",
        "コンテンツ制作",
        "データ分析",
        "MTG",
        "事務作業",
        "休憩",
    }
)
CATEGORY_FALLBACK = "不明"
PROMPT_VERSION = "v1"

# ---------------------------------------------------------------------------
# Global runtime (set in main)
# ---------------------------------------------------------------------------
DRY_RUN = False
BACKFILL_DATE: str | None = None

# Albona / myloggy 公開ページ（CLAUDE.md・設計 §4.7）。環境変数はこの値と完全一致必須。
EXPECTED_PARENT_PAGE_ID = "358f45ad-1826-8057-93d3-d7d7cd885e1d"

# Notion relation プロパティの実務上限に近いため、超過分は切り捨て（データ欠損より同期停止を避ける）。
NOTION_RELATION_MAX = 100

# STRICT_EXIT_CODE=true かつ errors/ollama_fail 時のみ exit 1。デフォルト false で launchd の短周期再実行を避ける。


class SyncAbort(Exception):
    """Controlled abort (missing env, parent check, etc.)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class StateSaveError(Exception):
    """Persisting sync_state.json failed; do not continue with inconsistent state."""


def norm_id(s: str) -> str:
    return str(s).replace("-", "").lower()


def today_jst_str() -> str:
    now = datetime.now(JST)
    return now.date().isoformat()


def parse_iso_ts(s: str) -> datetime:
    ss = s.strip().replace("Z", "+00:00")
    return datetime.fromisoformat(ss)


def load_env_simple(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        key = k.strip()
        val = v.strip().strip('"').strip("'")
        if key:
            out[key] = val
    return out


def merge_os_env_overrides(
    env: dict[str, str],
    keys: tuple[str, ...] = (
        "NOTION_TOKEN",
        "NOTION_PARENT_PAGE_ID",
        "NOTION_DB_WORK_LOG",
        "NOTION_DB_DAILY_REPORT",
        "SQLITE_PATH",
        "OLLAMA_HOST",
        "OLLAMA_MODEL",
        "OLLAMA_TIMEOUT_SECONDS",
    ),
) -> None:
    """Shell export overrides .env (last wins)."""
    for k in keys:
        v = os.environ.get(k)
        if v is not None and str(v).strip():
            env[k] = str(v).strip()


def warn_env_file_permissions(path: Path, log: logging.Logger) -> None:
    if not path.exists():
        return
    try:
        mode = path.stat().st_mode
    except OSError:
        return
    if mode & stat.S_IRWXG or mode & stat.S_IRWXO:
        log.warning(
            ".env permission too open: %s (recommend chmod 600)",
            oct(mode & 0o777),
        )


def setup_logging() -> logging.Logger:
    log_dir = REPO_ROOT / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    day = datetime.now(JST).strftime("%Y-%m-%d")
    log_path = log_dir / f"sync-{day}.log"
    log = logging.getLogger("myloggy_sync")
    log.setLevel(logging.INFO)
    log.handlers.clear()
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setFormatter(fmt)
    log.addHandler(fh)
    return log


def normalize_sync_history_stats(stats: dict[str, int] | None) -> dict[str, int]:
    raw = stats or {}
    return {k: int(raw.get(k, 0)) for k in SYNC_HISTORY_STAT_KEYS}


def append_sync_history_line(
    *,
    status: str,
    stats: dict[str, int],
    duration_s: int,
    reason: str | None,
) -> None:
    """Append one summary line to sync-history.log; failures must not affect sync."""
    ts = datetime.now(JST).isoformat(timespec="seconds")
    ns = normalize_sync_history_stats(stats)
    parts = [
        ts,
        status,
        f"delta={ns['delta']}",
        f"l1_added={ns['l1_added']}",
        f"l1_updated={ns['l1_updated']}",
        f"l2_added={ns['l2_added']}",
        f"l2_updated={ns['l2_updated']}",
        f"ollama_fail={ns['ollama_fail']}",
        f"errors={ns['errors']}",
        f"duration_s={duration_s}",
    ]
    if status == "FAIL" and reason:
        parts.append(f"reason={reason}")
    line = "\t".join(parts) + "\n"
    try:
        SYNC_HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(SYNC_HISTORY_PATH, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError as e:
        print(
            f"Warning: could not append sync history ({type(e).__name__}): {e}",
            file=sys.stderr,
        )


def acquire_lock() -> bool:
    import fcntl

    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    fp = open(LOCK_PATH, "a+", encoding="utf-8")
    try:
        fcntl.flock(fp.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fp.close()
        return False
    # stash on module — closed at exit
    acquire_lock._fp = fp  # type: ignore[attr-defined]
    return True


def default_state() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "last_cursor": None,
        "id_map": {},
        "layer1_synced_ids": [],
        "layer2_pending_dates": [],
        "ollama_retry_queue": [],
    }


def atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    payload = json.dumps(data, ensure_ascii=False, indent=2)
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(payload)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    # backup
    try:
        import shutil

        shutil.copy2(path, STATE_BAK_PATH)
    except OSError:
        pass


def load_state(log: logging.Logger) -> tuple[dict[str, Any], bool]:
    """Returns (state, need_rebuild_from_notion). Rebuild only if no readable JSON."""
    for candidate, label in (
        (STATE_PATH, "primary"),
        (STATE_BAK_PATH, "backup"),
    ):
        if not candidate.exists():
            continue
        try:
            with open(candidate, encoding="utf-8") as f:
                data = json.load(f)
            if label == "backup":
                log.warning("Recovered sync state from backup file")
            merged = default_state()
            merged.update(data)
            return merged, False
        except (json.JSONDecodeError, OSError) as e:
            log.warning("Failed to read state (%s): %s", label, type(e).__name__)
    log.warning("State missing or corrupt; will rebuild id_map from Notion when possible")
    return default_state(), True


def save_state(state: dict[str, Any], log: logging.Logger) -> None:
    ids = state.get("layer1_synced_ids")
    if isinstance(ids, list) and len(ids) > 1000:
        state["layer1_synced_ids"] = ids[-1000:]
    try:
        atomic_write_json(STATE_PATH, state)
    except OSError as e:
        log.error("Failed to save state: %s", e)
        raise StateSaveError("atomic_write_failed") from e


def notion_headers(token: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }


def http_request(
    log: logging.Logger,
    method: str,
    url: str,
    headers: dict[str, str],
    body: bytes | None = None,
    timeout: int = 120,
) -> tuple[int, dict[str, Any] | list[Any] | None, dict[str, str]]:
    """Return (status, parsed_json_or_None, response_headers)."""
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            h = {k.lower(): v for k, v in resp.headers.items()}
            status = resp.status
    except urllib.error.HTTPError as e:
        raw = e.read()
        h = {k.lower(): v for k, v in e.headers.items()} if e.headers else {}
        status = e.code
    except Exception:
        raise
    parsed: dict[str, Any] | list[Any] | None = None
    if raw:
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            parsed = None
    return status, parsed, h


def notion_call(
    log: logging.Logger,
    token: str,
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    timeout: int = 120,
) -> tuple[int, dict[str, Any] | list[Any] | None, dict[str, str]]:
    """Retry 429 / 5xx up to 3 times."""
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = notion_headers(token)
    delays = (1, 2, 4)
    last_status = 0
    last_parsed = None
    last_headers: dict[str, str] = {}
    for attempt in range(3):
        status, parsed, rh = http_request(log, method, url, headers, body, timeout=timeout)
        last_status, last_parsed, last_headers = status, parsed, rh
        if status == 429 or status >= 500:
            ra = rh.get("retry-after")
            wait = float(ra) if ra else delays[min(attempt, 2)]
            log.warning("Notion HTTP %s; retry in %ss (%s/%s)", status, wait, attempt + 1, 3)
            time.sleep(wait)
            continue
        return status, parsed, rh
    return last_status, last_parsed, last_headers


def verify_parent_page(token: str, parent_id: str, log: logging.Logger) -> None:
    url = f"https://api.notion.com/v1/pages/{parent_id}"
    status, data, _ = notion_call(log, token, "GET", url, None, timeout=60)
    if status != 200 or not isinstance(data, dict):
        log.critical("Parent page verification failed: HTTP %s", status)
        raise SyncAbort("parent_check_failed")
    rid = norm_id(str(data.get("id", "")))
    exp = norm_id(parent_id)
    if rid != exp:
        log.critical("Parent page id mismatch after verification")
        raise SyncAbort("parent_check_failed")


def verify_expected_parent_env(parent_id: str, log: logging.Logger) -> None:
    if parent_id != EXPECTED_PARENT_PAGE_ID:
        log.critical(
            "NOTION_PARENT_PAGE_ID must exactly match Albona root page %s (got %s)",
            EXPECTED_PARENT_PAGE_ID,
            parent_id,
        )
        raise SyncAbort("parent_page_id_env_mismatch")


def verify_database_parent(
    log: logging.Logger,
    token: str,
    database_id: str,
    label: str,
) -> None:
    """Ensure DB is nested under EXPECTED_PARENT_PAGE_ID (GET /v1/databases/{id})."""
    url = f"https://api.notion.com/v1/databases/{database_id}"
    status, data, _ = notion_call(log, token, "GET", url, None, timeout=60)
    if status != 200 or not isinstance(data, dict):
        log.critical(
            "Database parent verification failed for %s (%s): HTTP %s",
            label,
            database_id,
            status,
        )
        raise SyncAbort("database_parent_check_failed")
    parent = data.get("parent")
    if not isinstance(parent, dict):
        log.critical("Database %s: missing parent in API response", label)
        raise SyncAbort("database_parent_check_failed")
    if parent.get("type") != "page_id":
        log.critical(
            "Database %s: parent type is %r, expected page_id",
            label,
            parent.get("type"),
        )
        raise SyncAbort("database_parent_check_failed")
    pid = parent.get("page_id")
    if norm_id(str(pid or "")) != norm_id(EXPECTED_PARENT_PAGE_ID):
        log.critical(
            "Database %s: parent page_id differs from expected Albona root",
            label,
        )
        raise SyncAbort("database_parent_page_mismatch")


def verify_notion_workspace_safety(
    log: logging.Logger,
    token: str,
    env: dict[str, str],
) -> None:
    """Runs on every start including --dry-run."""
    verify_expected_parent_env(env["NOTION_PARENT_PAGE_ID"], log)
    verify_parent_page(token, EXPECTED_PARENT_PAGE_ID, log)
    verify_database_parent(log, token, env["NOTION_DB_WORK_LOG"], "NOTION_DB_WORK_LOG")
    verify_database_parent(log, token, env["NOTION_DB_DAILY_REPORT"], "NOTION_DB_DAILY_REPORT")


def truncate_text(s: str, max_len: int) -> str:
    if len(s) <= max_len:
        return s
    if max_len <= 1:
        return "…"
    return s[: max_len - 1] + "…"


def rich_text_content(text: str) -> list[dict[str, Any]]:
    if not text:
        return [
            {
                "type": "text",
                "text": {"content": ""},
                "annotations": {
                    "bold": False,
                    "italic": False,
                    "strikethrough": False,
                    "underline": False,
                    "code": False,
                    "color": "default",
                },
            }
        ]
    return [
        {
            "type": "text",
            "text": {"content": text},
            "annotations": {
                "bold": False,
                "italic": False,
                "strikethrough": False,
                "underline": False,
                "code": False,
                "color": "default",
            },
        }
    ]


def notion_date_prop(dt: datetime) -> dict[str, Any]:
    """Notion: time_zone と非UTCオフセット付き start は併用不可のため、オフセットのみで渡す。"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=JST)
    dt = dt.astimezone(JST)
    return {"date": {"start": dt.isoformat()}}


def normalize_category(cat: str) -> str:
    s = (cat or "").strip()
    if s in CATEGORY_PRESETS:
        return s
    return CATEGORY_FALLBACK


def extract_plain(prop: dict[str, Any] | None) -> str:
    if not prop:
        return ""
    ptype = prop.get("type")
    if ptype == "rich_text":
        parts = prop.get("rich_text") or []
        return "".join((p.get("plain_text") or "") for p in parts)
    if ptype == "title":
        parts = prop.get("title") or []
        return "".join((p.get("plain_text") or "") for p in parts)
    if ptype == "select":
        sel = prop.get("select")
        return (sel or {}).get("name") or "" if sel else ""
    return ""


def query_all_by_sync_key(
    log: logging.Logger,
    token: str,
    database_id: str,
) -> dict[str, str]:
    """Map 同期キー plain_text → page id."""
    url = f"https://api.notion.com/v1/databases/{database_id}/query"
    result: dict[str, str] = {}
    body: dict[str, Any] = {"page_size": 100}
    while True:
        status, data, _ = notion_call(log, token, "POST", url, body, timeout=120)
        if status != 200 or not isinstance(data, dict):
            log.warning("Database query failed during rebuild (HTTP %s)", status)
            break
        for page in data.get("results") or []:
            if not isinstance(page, dict):
                continue
            pid = page.get("id")
            props = page.get("properties") or {}
            sk_prop = props.get(SYNC_KEY_PROP)
            if not isinstance(sk_prop, dict):
                continue
            key = extract_plain(sk_prop).strip()
            if key and pid:
                result[key] = str(pid)
        if not data.get("has_more"):
            break
        body = {"page_size": 100, "start_cursor": data.get("next_cursor")}
    return result


def find_page_by_sync_key(
    log: logging.Logger,
    token: str,
    database_id: str,
    sync_key: str,
) -> str | None:
    url = f"https://api.notion.com/v1/databases/{database_id}/query"
    payload = {
        "filter": {"property": SYNC_KEY_PROP, "rich_text": {"equals": sync_key}},
        "page_size": 5,
    }
    status, data, _ = notion_call(log, token, "POST", url, payload, timeout=60)
    if status != 200 or not isinstance(data, dict):
        return None
    results = data.get("results") or []
    if not results:
        return None
    p = results[0]
    if isinstance(p, dict) and p.get("id"):
        return str(p["id"])
    return None


def fetch_page_properties(log: logging.Logger, token: str, page_id: str) -> dict[str, Any] | None:
    url = f"https://api.notion.com/v1/pages/{page_id}"
    status, data, _ = notion_call(log, token, "GET", url, None, timeout=60)
    if status != 200 or not isinstance(data, dict):
        return None
    return data.get("properties") or {}


@dataclass
class DaySeg:
    day: str  # YYYY-MM-DD JST
    minutes: float
    category: str
    project_name: str
    work_unit_id: str


def split_unit_to_days(
    wu_id: str,
    category: str,
    project_name: str,
    start_at: str,
    end_at: str,
    duration_minutes: int,
    norm_cat: str,
) -> list[DaySeg]:
    """比例按分: segment_wall_minutes / total_wall * duration_minutes."""
    s = parse_iso_ts(start_at)
    e = parse_iso_ts(end_at)
    total_seconds = max(0.0, (e - s).total_seconds())
    total_wall_minutes = total_seconds / 60.0
    if total_wall_minutes <= 1e-6:
        day = s.astimezone(JST).date().isoformat()
        return [DaySeg(day, float(duration_minutes), norm_cat, project_name, wu_id)]

    segs: list[DaySeg] = []
    cur = s
    while cur < e:
        cur_j = cur.astimezone(JST)
        day_start = cur_j.replace(hour=0, minute=0, second=0, microsecond=0)
        next_local = (day_start + timedelta(days=1)).astimezone(timezone.utc)
        seg_end = min(e, next_local)
        wall_min = max(0.0, (seg_end - cur).total_seconds() / 60.0)
        share = duration_minutes * (wall_min / total_wall_minutes) if total_wall_minutes else 0.0
        day_str = cur_j.date().isoformat()
        segs.append(DaySeg(day_str, share, norm_cat, project_name, wu_id))
        cur = seg_end
    if not segs:
        day = s.astimezone(JST).date().isoformat()
        segs.append(DaySeg(day, float(duration_minutes), norm_cat, project_name, wu_id))
    return segs


def aggregate_day(
    segments_by_day: dict[str, list[DaySeg]],
    day: str,
) -> tuple[float, dict[str, float], list[tuple[str, float]], float]:
    """Returns total_h, category_hours dict, top3 projects (name, h), break_h."""
    segs = segments_by_day.get(day, [])
    cat_h: dict[str, float] = defaultdict(float)
    proj_h: dict[str, float] = defaultdict(float)
    break_h = 0.0
    total_min = 0.0
    for sg in segs:
        total_min += sg.minutes
        cat_h[sg.category] += sg.minutes / 60.0
        proj_h[sg.project_name] += sg.minutes / 60.0
        if sg.category == "休憩":
            break_h += sg.minutes / 60.0
    total_h = total_min / 60.0
    top3 = sorted(proj_h.items(), key=lambda x: -x[1])[:3]
    return total_h, dict(cat_h), top3, break_h


def fmt_category_breakdown(cat_h: dict[str, float]) -> str:
    if not cat_h:
        return ""
    parts = [f"{k}: {v:.2f}h" for k, v in sorted(cat_h.items(), key=lambda x: (-x[1], x[0]))]
    return " / ".join(parts)


def fmt_top_projects(top3: list[tuple[str, float]]) -> str:
    return " / ".join(f"{name} ({h:.2f}h)" for name, h in top3 if name)


def sqlite_connect_with_retry(path: str, log: logging.Logger, attempts: int = 3) -> sqlite3.Connection:
    last: Exception | None = None
    for i in range(attempts):
        try:
            p = quote(path, safe="/:")
            uri = f"file:{p}?mode=ro"
            return sqlite3.connect(uri, uri=True, timeout=8.0)
        except sqlite3.OperationalError as e:
            last = e
            time.sleep(1 * (2**i))
            log.warning("SQLite busy; retry %s/%s", i + 1, attempts)
    log.error("SQLite open failed after retries")
    raise last if last else RuntimeError("sqlite")


def fetch_work_unit_rows(
    conn: sqlite3.Connection,
    last_cursor: dict[str, str] | None,
) -> list[dict[str, Any]]:
    cols = (
        "id, start_at, end_at, duration_minutes, title, project_name, "
        "category, summary, user_edited, updated_at"
    )
    if not last_cursor or not last_cursor.get("updated_at") or not last_cursor.get("id"):
        sql = (
            f"SELECT {cols} FROM work_units ORDER BY updated_at ASC, id ASC"
        )
        cur = conn.execute(sql)
    else:
        sql = (
            f"SELECT {cols} FROM work_units WHERE updated_at > ? OR "
            "(updated_at = ? AND id > ?) ORDER BY updated_at ASC, id ASC"
        )
        cur = conn.execute(
            sql,
            (last_cursor["updated_at"], last_cursor["updated_at"], last_cursor["id"]),
        )
    rows = []
    for r in cur.fetchall():
        rows.append(
            {
                "id": r[0],
                "start_at": r[1],
                "end_at": r[2],
                "duration_minutes": r[3],
                "title": r[4],
                "project_name": r[5],
                "category": r[6],
                "summary": r[7],
                "user_edited": bool(r[8]),
                "updated_at": r[9],
            }
        )
    return rows


def all_segments_from_db(conn: sqlite3.Connection) -> dict[str, list[DaySeg]]:
    """全 work_units から日別セグメント（Layer2 集計用）。"""
    cur = conn.execute(
        "SELECT id, start_at, end_at, duration_minutes, project_name, category "
        "FROM work_units"
    )
    rows = []
    for r in cur.fetchall():
        rows.append(
            {
                "id": r[0],
                "start_at": r[1],
                "end_at": r[2],
                "duration_minutes": r[3],
                "project_name": r[4],
                "category": r[5],
            }
        )
    by_day: dict[str, list[DaySeg]] = defaultdict(list)
    for r in rows:
        nc = normalize_category(str(r["category"]))
        segs = split_unit_to_days(
            str(r["id"]),
            str(r["category"]),
            str(r["project_name"]),
            str(r["start_at"]),
            str(r["end_at"]),
            int(r["duration_minutes"]),
            nc,
        )
        for sg in segs:
            by_day[sg.day].append(sg)
    return by_day


def segments_for_dates(
    conn: sqlite3.Connection,
    target_dates: set[str],
) -> dict[str, list[DaySeg]]:
    """対象 JST 日のみセグメント化。SQL は時刻窓で絞り、按分後に target_dates のみ保持。"""
    if not target_dates:
        return {}
    min_d = min(target_dates)
    max_d = max(target_dates)
    day0 = datetime.fromisoformat(min_d).date()
    day1 = datetime.fromisoformat(max_d).date()
    win_start = datetime.combine(day0, datetime.min.time()).replace(tzinfo=JST) - timedelta(days=1)
    win_end = datetime.combine(day1, datetime.min.time()).replace(tzinfo=JST) + timedelta(days=2)
    lo = win_start.astimezone(timezone.utc).isoformat()
    hi = win_end.astimezone(timezone.utc).isoformat()
    cur = conn.execute(
        "SELECT id, start_at, end_at, duration_minutes, project_name, category "
        "FROM work_units WHERE end_at >= ? AND start_at <= ?",
        (lo, hi),
    )
    by_day: dict[str, list[DaySeg]] = defaultdict(list)
    for r in cur.fetchall():
        nc = normalize_category(str(r[5]))
        segs = split_unit_to_days(
            str(r[0]),
            str(r[5]),
            str(r[4]),
            str(r[1]),
            str(r[2]),
            int(r[3]),
            nc,
        )
        for sg in segs:
            if sg.day in target_dates:
                by_day[sg.day].append(sg)
    return by_day


def affected_jst_days_from_row(row: dict[str, Any]) -> set[str]:
    s = parse_iso_ts(str(row["start_at"])).astimezone(JST)
    e = parse_iso_ts(str(row["end_at"])).astimezone(JST)
    d0, d1 = s.date(), e.date()
    out: set[str] = set()
    cur = d0
    while cur <= d1:
        out.add(cur.isoformat())
        cur += timedelta(days=1)
    return out


# Notion: 1 リッチテキスト断片あたりの実質上限に合わせて切り詰め
NOTION_TEXT_MAX = 2000


def layer1_properties(
    row: dict[str, Any],
    now_utc: datetime,
) -> dict[str, Any]:
    s = parse_iso_ts(str(row["start_at"])).astimezone(JST)
    e = parse_iso_ts(str(row["end_at"])).astimezone(JST)
    wu_id = str(row["id"])
    upd = str(row["updated_at"])
    hours = round(int(row["duration_minutes"]) / 60.0, 2)
    cat = normalize_category(str(row["category"]))
    title = truncate_text(str(row["title"]), NOTION_TEXT_MAX)
    project = truncate_text(str(row["project_name"]), NOTION_TEXT_MAX)
    summary = truncate_text(str(row["summary"]), NOTION_TEXT_MAX)
    return {
        L1_TITLE: {"title": rich_text_content(title)},
        L1_START: notion_date_prop(s),
        L1_END: notion_date_prop(e),
        L1_HOURS: {"number": hours},
        L1_CATEGORY: {"select": {"name": cat}},
        L1_PROJECT: {"rich_text": rich_text_content(project)},
        L1_SUMMARY: {"rich_text": rich_text_content(summary)},
        L1_USER_EDITED: {"checkbox": bool(row["user_edited"])},
        L1_SYNC_KEY: {"rich_text": rich_text_content(wu_id)},
        L1_CURSOR: {"rich_text": rich_text_content(f"{upd}|{wu_id}")},
        L1_LAST_SYNC: notion_date_prop(now_utc.astimezone(JST)),
    }


def patch_or_create_l1(
    log: logging.Logger,
    env: dict[str, str],
    state: dict[str, Any],
    row: dict[str, Any],
    stats: dict[str, int],
) -> bool:
    wu_id = str(row["id"])
    dbid = env["NOTION_DB_WORK_LOG"]
    token = env["NOTION_TOKEN"]
    now_utc = datetime.now(timezone.utc)
    props = layer1_properties(row, now_utc)

    if DRY_RUN:
        stats["l1_would"] = stats.get("l1_would", 0) + 1
        return True

    def create_new() -> bool:
        url = "https://api.notion.com/v1/pages"
        payload = {
            "parent": {"database_id": dbid},
            "properties": props,
        }
        status, data, _ = notion_call(log, token, "POST", url, payload, timeout=60)
        if status != 200 or not isinstance(data, dict):
            msg = ""
            if isinstance(data, dict):
                msg = str(data.get("message") or "")[:300]
            log.warning("L1 create failed (HTTP %s)%s", status, f": {msg}" if msg else "")
            stats["errors"] = stats.get("errors", 0) + 1
            return False
        new_id = data.get("id")
        if new_id:
            state["id_map"][wu_id] = str(new_id)
        stats["l1_added"] = stats.get("l1_added", 0) + 1
        return True

    page_id = state["id_map"].get(wu_id)
    if not page_id:
        page_id = find_page_by_sync_key(log, token, dbid, wu_id)
    if page_id is None:
        return create_new()

    heal_attempted = False
    while True:
        url = f"https://api.notion.com/v1/pages/{page_id}"
        payload = {"properties": props}
        status, data, _ = notion_call(log, token, "PATCH", url, payload, timeout=60)
        if status == 200:
            state["id_map"][wu_id] = page_id
            stats["l1_updated"] = stats.get("l1_updated", 0) + 1
            return True
        if status == 404 and not heal_attempted:
            heal_attempted = True
            state["id_map"].pop(wu_id, None)
            save_state(state, log)
            found = find_page_by_sync_key(log, token, dbid, wu_id)
            if found:
                log.info(
                    "Self-heal: stale page_id removed for sync_key=%s, re-resolved via query",
                    wu_id,
                )
                page_id = found
                state["id_map"][wu_id] = found
                save_state(state, log)
                continue
            log.info(
                "Self-heal: stale page_id removed for sync_key=%s, recreated",
                wu_id,
            )
            return create_new()
        msg = ""
        if isinstance(data, dict):
            msg = str(data.get("message") or "")[:300]
        log.warning("L1 update failed (HTTP %s)%s", status, f": {msg}" if msg else "")
        stats["errors"] = stats.get("errors", 0) + 1
        return False


def daily_sync_key(d: str) -> str:
    return f"daily:{d}:Asia/Tokyo"


def ollama_generate(
    log: logging.Logger,
    host: str,
    model: str,
    prompt: str,
    timeout_s: int = 120,
) -> str | None:
    url = host.rstrip("/") + "/api/generate"
    body = json.dumps(
        {
            "model": model,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.3, "num_predict": 256},
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            raw = resp.read()
            data = json.loads(raw.decode("utf-8"))
            return str(data.get("response") or "").strip() or None
    except Exception as e:
        log.warning("Ollama generate failed: %s", type(e).__name__)
        return None


def work_unit_lines_for_prompt(
    conn: sqlite3.Connection,
    day: str,
    segments: dict[str, list[DaySeg]],
) -> list[str]:
    """その日に重なる work_units の代表情報（title 等は別途 SQLite から）。"""
    unit_ids = {sg.work_unit_id for sg in segments.get(day, [])}
    if not unit_ids:
        return []
    qmarks = ",".join("?" * len(unit_ids))
    cur = conn.execute(
        f"SELECT id, title, duration_minutes, category, project_name FROM work_units WHERE id IN ({qmarks})",
        tuple(unit_ids),
    )
    lines = []
    for r in cur.fetchall():
        lines.append(
            f"- id={r[0]} | {r[1]} | {r[2]}m | {r[3]} | project={r[4]}"
        )
    return sorted(lines)


def layer2_upsert(
    log: logging.Logger,
    env: dict[str, str],
    state: dict[str, Any],
    conn: sqlite3.Connection,
    day: str,
    segments_all: dict[str, list[DaySeg]],
    *,
    force_backfill: bool,
    stats: dict[str, int],
) -> bool:
    token = env["NOTION_TOKEN"]
    dbid = env["NOTION_DB_DAILY_REPORT"]
    sync_k = daily_sync_key(day)
    today = today_jst_str()
    is_today = day == today
    finalized_target = not is_today

    total_h, cat_h, top3, break_h = aggregate_day(segments_all, day)
    cat_txt = fmt_category_breakdown(cat_h)
    top_txt = fmt_top_projects(top3)

    unit_ids = list({sg.work_unit_id for sg in segments_all.get(day, [])})
    unit_ids.sort()
    nu = len(unit_ids)
    if nu > NOTION_RELATION_MAX:
        log.warning(
            "Layer2 day %s: relation truncated to %s items (had %s)",
            day,
            NOTION_RELATION_MAX,
            nu,
        )
        unit_ids = unit_ids[-NOTION_RELATION_MAX:]

    rel_ids: list[dict[str, str]] = []
    missing = 0
    for uid in unit_ids:
        pid = state["id_map"].get(uid)
        if pid:
            rel_ids.append({"id": pid})
        else:
            missing += 1
    if missing:
        log.info("Layer2 day %s: %s work_units missing id_map (not yet synced to L1)", day, missing)

    now_utc = datetime.now(timezone.utc)

    page_id = state["id_map"].get(sync_k) or find_page_by_sync_key(log, token, dbid, sync_k)

    existing_final = False
    existing_impression = ""
    props_fetch_failed = False
    if page_id and not force_backfill:
        ep = fetch_page_properties(log, token, page_id)
        if ep is None:
            props_fetch_failed = True
            if not is_today:
                log.warning(
                    "Layer2 freeze fallback: cannot read existing page properties for %s, "
                    "skipping impression update",
                    day,
                )
        else:
            cf = ep.get(L2_FINALIZED)
            if isinstance(cf, dict) and cf.get("type") == "checkbox":
                existing_final = bool(cf.get("checkbox"))
            existing_impression = extract_plain(ep.get(L2_IMPRESSION))

    if force_backfill:
        need_impression = True
    elif props_fetch_failed and not is_today and page_id:
        need_impression = False
    elif is_today:
        need_impression = True
    elif not page_id:
        need_impression = True
    elif not is_today and existing_final and existing_impression.strip():
        need_impression = False
    else:
        need_impression = True

    impression_text: str | None = None
    model = env.get("OLLAMA_MODEL", "gemma3:27b")
    if need_impression and not DRY_RUN:
        lines = work_unit_lines_for_prompt(conn, day, segments_all)
        prompt = (
            f"以下は{day}の作業ログです。3-4文で振り返り所感を生成してください。\n"
            "- 何に時間を使ったか\n"
            "- 特徴的な動きや傾向\n"
            "- 改善の余地\n\n"
            + "\n".join(lines)
        )
        try:
            ota = int(env.get("OLLAMA_TIMEOUT_SECONDS", "120"))
        except ValueError:
            ota = 120
        impression_text = ollama_generate(
            log,
            env.get("OLLAMA_HOST", "http://127.0.0.1:11434"),
            model,
            prompt,
            timeout_s=ota,
        )
        if impression_text is None:
            stats["ollama_fail"] = stats.get("ollama_fail", 0) + 1
            if day not in state["ollama_retry_queue"]:
                state["ollama_retry_queue"].append(day)
            impression_text = ""
        else:
            if day in state["ollama_retry_queue"]:
                state["ollama_retry_queue"] = [x for x in state["ollama_retry_queue"] if x != day]

    elif need_impression and DRY_RUN:
        impression_text = ""
        log.info("[dry-run] Would generate Ollama impression for %s", day)
    else:
        impression_text = existing_impression

    props: dict[str, Any] = {
        L2_TITLE: {"title": rich_text_content(day)},
        L2_DATE_PROP: {"date": {"start": day}},
        L2_SYNC_KEY: {"rich_text": rich_text_content(sync_k)},
        L2_TOTAL_H: {"number": round(total_h, 2)},
        L2_CAT_BREAKDOWN: {"rich_text": rich_text_content(cat_txt)},
        L2_TOP_PROJECTS: {"rich_text": rich_text_content(top_txt)},
        L2_BREAK_H: {"number": round(break_h, 2)},
        L2_REL_WORK_LOG: {"relation": rel_ids},
        L2_FINALIZED: {"checkbox": finalized_target},
        L2_GENERATED_AT: notion_date_prop(now_utc.astimezone(JST)),
    }

    impression_patch_keys = {L2_IMPRESSION, L2_MODEL, L2_PROMPT_VER, L2_IMPRESSION_TIME}
    if is_today:
        props[L2_IMPRESSION] = {"rich_text": rich_text_content(impression_text or "")}
        props[L2_MODEL] = {"rich_text": rich_text_content(model)}
        props[L2_PROMPT_VER] = {"rich_text": rich_text_content(PROMPT_VERSION)}
        props[L2_IMPRESSION_TIME] = notion_date_prop(now_utc.astimezone(JST))
    elif need_impression and impression_text is not None:
        props[L2_IMPRESSION] = {"rich_text": rich_text_content(impression_text)}
        props[L2_MODEL] = {"rich_text": rich_text_content(model)}
        props[L2_PROMPT_VER] = {"rich_text": rich_text_content(PROMPT_VERSION)}
        props[L2_IMPRESSION_TIME] = notion_date_prop(now_utc.astimezone(JST))

    if DRY_RUN:
        log.info(
            "[dry-run] Would upsert Layer2 %s finalized=%s impression_len=%s",
            day,
            finalized_target,
            len(impression_text or ""),
        )
        stats["l2_would"] = stats.get("l2_would", 0) + 1
        return True

    if page_id is None:
        url = "https://api.notion.com/v1/pages"
        payload = {"parent": {"database_id": dbid}, "properties": props}
        status, data, _ = notion_call(log, token, "POST", url, payload, timeout=60)
        if status != 200 or not isinstance(data, dict):
            log.warning("L2 create failed for day %s (HTTP %s)", day, status)
            stats["errors"] = stats.get("errors", 0) + 1
            return False
        new_id = data.get("id")
        if new_id:
            state["id_map"][sync_k] = str(new_id)
        stats["l2_added"] = stats.get("l2_added", 0) + 1
    else:
        if not need_impression:
            for k in impression_patch_keys:
                props.pop(k, None)
        heal_attempted = False
        while True:
            url = f"https://api.notion.com/v1/pages/{page_id}"
            status, data, _ = notion_call(
                log,
                token,
                "PATCH",
                url,
                {"properties": props},
                timeout=60,
            )
            if status == 200:
                state["id_map"][sync_k] = page_id
                stats["l2_updated"] = stats.get("l2_updated", 0) + 1
                return True
            if status == 404 and not heal_attempted:
                heal_attempted = True
                state["id_map"].pop(sync_k, None)
                save_state(state, log)
                found = find_page_by_sync_key(log, token, dbid, sync_k)
                if found:
                    log.info(
                        "Self-heal: stale page_id removed for sync_key=%s, re-resolved via query",
                        sync_k,
                    )
                    page_id = found
                    state["id_map"][sync_k] = found
                    save_state(state, log)
                    continue
                log.info(
                    "Self-heal: stale page_id removed for sync_key=%s, recreated",
                    sync_k,
                )
                url_c = "https://api.notion.com/v1/pages"
                payload_c = {"parent": {"database_id": dbid}, "properties": props}
                st2, dat2, _ = notion_call(log, token, "POST", url_c, payload_c, timeout=60)
                if st2 != 200 or not isinstance(dat2, dict):
                    log.warning("L2 create failed for day %s (HTTP %s)", day, st2)
                    stats["errors"] = stats.get("errors", 0) + 1
                    return False
                new_id = dat2.get("id")
                if new_id:
                    state["id_map"][sync_k] = str(new_id)
                stats["l2_added"] = stats.get("l2_added", 0) + 1
                return True
            log.warning("L2 update failed for day %s (HTTP %s)", day, status)
            stats["errors"] = stats.get("errors", 0) + 1
            return False

    return True


def rebuild_id_maps(log: logging.Logger, env: dict[str, str], state: dict[str, Any]) -> None:
    l1 = query_all_by_sync_key(log, env["NOTION_TOKEN"], env["NOTION_DB_WORK_LOG"])
    l2 = query_all_by_sync_key(log, env["NOTION_TOKEN"], env["NOTION_DB_DAILY_REPORT"])
    merged = {**l1, **l2}
    state["id_map"].update(merged)
    log.info("Rebuilt id_map from Notion (%s keys)", len(merged))


def run() -> None:
    global DRY_RUN, BACKFILL_DATE

    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--once", action="store_true", help="Default: run once and exit")
    ap.add_argument("--backfill", metavar="YYYY-MM-DD", default=None)
    args = ap.parse_args()
    if not args.once and not args.dry_run and not args.backfill:
        pass  # default once

    DRY_RUN = args.dry_run
    BACKFILL_DATE = args.backfill

    t0 = time.time()
    hist_skip = False
    hist_status = "OK"
    hist_reason: str | None = None
    hist_stats: dict[str, int] | None = None
    exit_code = 0

    log = setup_logging()
    log.info("sync_to_notion start dry_run=%s backfill=%s", DRY_RUN, BACKFILL_DATE or "")
    try:
        env = load_env_simple(ENV_PATH)
        warn_env_file_permissions(ENV_PATH, log)
        merge_os_env_overrides(env)
        required = (
            "NOTION_TOKEN",
            "NOTION_PARENT_PAGE_ID",
            "NOTION_DB_WORK_LOG",
            "NOTION_DB_DAILY_REPORT",
            "SQLITE_PATH",
        )
        for k in required:
            if k not in env or not env[k]:
                log.error("Missing env var: %s (via %s)", k, ENV_PATH)
                raise SyncAbort("missing_env")

        if not acquire_lock():
            hist_skip = True
            return

        hist_stats = {k: 0 for k in SYNC_HISTORY_STAT_KEYS}
        stats: dict[str, int] = hist_stats

        state, need_rebuild = load_state(log)
        verify_notion_workspace_safety(log, env["NOTION_TOKEN"], env)
        if need_rebuild:
            try:
                rebuild_id_maps(log, env, state)
                if not DRY_RUN:
                    save_state(state, log)
            except Exception as e:
                log.warning("Could not rebuild id_map from Notion: %s", type(e).__name__)

        sqlite_path = env["SQLITE_PATH"]
        if not Path(sqlite_path).exists():
            log.error("SQLite not found at path from env")
            raise SyncAbort("sqlite_not_found")

        conn = sqlite_connect_with_retry(sqlite_path, log)
        try:
            today = today_jst_str()

            # --- Hook: past pending Layer2 first (§5.3) ---
            pending = sorted(set(state.get("layer2_pending_dates") or []))
            past_pending = [d for d in pending if d < today]
            if BACKFILL_DATE:
                seg_past = all_segments_from_db(conn)
            elif past_pending:
                seg_past = segments_for_dates(conn, set(past_pending))
            else:
                seg_past = {}

            for d in past_pending:
                ok = layer2_upsert(
                    log,
                    env,
                    state,
                    conn,
                    d,
                    seg_past,
                    force_backfill=(BACKFILL_DATE == d),
                    stats=stats,
                )
                if ok and d in state["layer2_pending_dates"]:
                    state["layer2_pending_dates"] = [
                        x for x in state["layer2_pending_dates"] if x != d
                    ]
                if not DRY_RUN:
                    save_state(state, log)

            # --- Layer 1 incremental ---
            last_cursor = state.get("last_cursor")
            rows = fetch_work_unit_rows(
                conn, last_cursor if isinstance(last_cursor, dict) else None
            )
            stats["delta"] = len(rows)
            log.info("SQLite delta rows: %s", len(rows))

            stall_cursor = False
            l1_fail_n = 0
            for row in rows:
                ok = patch_or_create_l1(log, env, state, row, stats)
                wid = str(row["id"])
                if ok:
                    if not stall_cursor:
                        state["last_cursor"] = {"updated_at": str(row["updated_at"]), "id": wid}
                    if wid not in state["layer1_synced_ids"]:
                        state["layer1_synced_ids"].append(wid)
                    days = affected_jst_days_from_row(row)
                    for d in days:
                        if d not in state["layer2_pending_dates"]:
                            state["layer2_pending_dates"].append(d)
                    if not DRY_RUN:
                        save_state(state, log)
                else:
                    stall_cursor = True
                    l1_fail_n += 1
                    log.warning("Layer1 work_unit failed id=%s (continuing)", wid[:12])
            if l1_fail_n:
                log.info(
                    "L1 partial failures: %s (will retry next run)",
                    l1_fail_n,
                )

            # --- retry queue ollama-only days: ensure L2 row exists then patch impression ---
            # Full L2 pass includes today + pending + backfill
            dates_to_run = sorted(
                set(state.get("layer2_pending_dates") or [])
                | {today}
                | set(state.get("ollama_retry_queue") or [])
            )
            if BACKFILL_DATE:
                dates_to_run = sorted(set(dates_to_run) | {BACKFILL_DATE})

            if BACKFILL_DATE:
                segments_all = all_segments_from_db(conn)
            else:
                segments_all = segments_for_dates(conn, set(dates_to_run))

            if DRY_RUN:
                log.info(
                    "Dry-run: layer2 date count=%s (%s)",
                    len(dates_to_run),
                    ",".join(dates_to_run),
                )

            for d in dates_to_run:
                force_bf = bool(BACKFILL_DATE and BACKFILL_DATE == d)
                ok = layer2_upsert(
                    log,
                    env,
                    state,
                    conn,
                    d,
                    segments_all,
                    force_backfill=force_bf,
                    stats=stats,
                )
                if ok:
                    state["layer2_pending_dates"] = [
                        x for x in state["layer2_pending_dates"] if x != d
                    ]
                    if not DRY_RUN:
                        save_state(state, log)

            log.info(
                "sync_to_notion end stats=%s", {k: v for k, v in stats.items()}
            )

            if stats.get("errors", 0) > 0:
                hist_status = "FAIL"
                hist_reason = hist_reason or "sync_errors"
            if stats.get("ollama_fail", 0) > 0:
                hist_status = "FAIL"
                hist_reason = hist_reason or "ollama_fail"

            strict_exit = os.environ.get("STRICT_EXIT_CODE", "").strip().lower() in (
                "1",
                "true",
                "yes",
            )
            if strict_exit and (
                stats.get("errors", 0) > 0 or stats.get("ollama_fail", 0) > 0
            ):
                exit_code = 1
        finally:
            conn.close()

    except SyncAbort as e:
        hist_status = "FAIL"
        hist_reason = e.reason
        exit_code = 1
    except StateSaveError as e:
        log.error("State save failed: %s", e)
        hist_status = "FAIL"
        hist_reason = "state_save_failed"
        exit_code = 1
    except Exception as e:
        log.exception("sync_to_notion failed: %s", e)
        hist_status = "FAIL"
        hist_reason = type(e).__name__.lower()
        exit_code = 1
    finally:
        if not hist_skip:
            duration_s = max(0, int(time.time() - t0))
            append_sync_history_line(
                status=hist_status,
                stats=hist_stats if hist_stats is not None else {},
                duration_s=duration_s,
                reason=hist_reason if hist_status == "FAIL" else None,
            )

    if exit_code:
        sys.exit(exit_code)


if __name__ == "__main__":
    try:
        run()
    except KeyboardInterrupt:
        sys.exit(130)
