# 2026-05-06 二重起動DBロック & LLM degenerate loop 出力

## 概要
dev二重起動で SQLite が `database is locked` を 39件発生させ、同時刻に Ollama LLM が暴走出力（`lang_label_lang_label_...` 等の繰返し）を生成して UI に表示された。プロセス整理 → DB cleanup → コード側のガード追加（commit `e5c7247`）まで実施。

## 経緯

| 時刻(JST) | 事象 |
|---|---|
| 21:16 | Electron インスタンス1 起動 (PID 66013) |
| 21:20 | Electron インスタンス2 起動 (PID 69231) — 二重起動 |
| 22:12〜23:15 | `database is locked` エラー 39件発生（capture 経路） |
| 22:14〜22:48 | 重複 checkpoint 48組が同 start_at で生成 |
| 22:47 | LLM 暴走出力が DB に着地: `task_label` 2098字 / `state_summary` 1922字 |
| 23:25 | ユーザーが UI 異常を発見し調査開始 |
| 23:25〜 | 両 Electron プロセス kill → 1個だけ起動し直し |
| 23:31〜23:33 | DB バックアップ取得 → 重複 cleanup 実行 |
| 23:36〜23:40 | コード修正を Cursor Agent 並列 dispatch（A/B/D） |
| 翌 00:?? | commit `e5c7247` で 4ファイル更新 |

## 原因

### 一次原因: dev の二重起動ガードが無かった
`scripts/dev.mjs` も `scripts/run-electron.mjs` も既存プロセス検知をしていなかった。`npm run dev` を 2回叩けば 2 Electron が同じ SQLite を開ける状態。

### 二次原因: Ollama gemma4:26b の暴走出力をサニタイザで検出できていなかった
`looksDegenerateModelText` の検出は `(\b\w{2,}\b)\s*(?:\|\s*\1\b\s*){4,}` ＝ **パイプ区切り限定**。実際の暴走パターン（アンダースコア／ハイフン／同文連打／n-gram繰返し）はすべて素通り。

加えて 120/500字 の length cap が、何らかの経路（暴走時の dist 不整合と推定）で効かず長文がそのまま DB 着地した。

## 対応

### C: DB cleanup（自分で実行）
- バックアップ取得: `myloggy.sqlite.bak.20260506_233130`
- 重複 48組のうち「健全な方」を残す方式で loser 48件を削除
  - スコア = `(task_label > 120 ? 100 : 0) + (state_summary > 500 ? 100 : 0) + (1 - confidence)`
  - 異常長レコード 2件（`cp_77b2a3fbbddf` / `cp_f94a04b455b0`）は loser 側に正しく分類された
- `snapshots.checkpoint_id` を 40件 winner に書き換え
- `work_units.checkpoint_ids_json` を 28件で loser→winner 置換 + dedupe
- 検証: 重複0 / 孤立 snapshot 0 / 超過長0

### A: degenerate detection 拡張（Cursor Agent dispatch）
`electron/core/llm.ts`:
- `looksDegenerateModelText` を `export` 化
- 同一トークン4回以上連続: 区切り `[_\-\s./|]+` を Unicode awareで判定（長トークン2字以上 / 短トークン1〜3字の2本）
- 5〜200字の n-gram が 3回以上出現で degenerate判定
- 新規 `electron/core/llm.test.ts`: positive 8 / negative 5 全 pass

### B: 二重起動ガード（Cursor Agent dispatch）
`scripts/dev.mjs`:
- `os.tmpdir()/myloggy-dev.pid` で既存プロセス検知
- `process.kill(pid, 0)` で生存判定（ESRCH=stale, EPERM=他ユーザだが生存扱い）
- 生存中は `[dev] another dev process is already running (pid=N). abort.` で `exit(1)`
- shutdown() で必ず削除

### D: insertCheckpoint hard cap 保険（Cursor Agent dispatch）
`electron/core/db.ts`:
- 定数 `MAX_TASK_LABEL=120 / STATE=500 / PROJECT=60 / EVIDENCE=80` を新設
- `insertCheckpoint()` 冒頭で各フィールドを長さチェック → 超過時は `console.warn` してから truncate
- record オブジェクトは mutate せずローカル変数経由で INSERT

### コミット
`e5c7247` (4 files changed, 327 insertions(+), 48 deletions(-))

## 学び・所感

- **二次被害の連鎖が大きい**: 二重起動 → DB lock → 重複 checkpoint → 暴走出力が両プロセスに保存 → UI バグ表示。最初の二重起動を防ぐだけで全部止まる。
- **looksDegenerateModelText は Unicode 文字含む degenerate に弱かった**: 当初は英語パイプ繰返し前提で書かれていた。日本語混じり・アンダースコア区切り・同文連打のような **より一般的な LLM 暴走パターン**を網羅すべき。
- **dist と src の世代差**: `tsc --watch` 中に dist が中途半端に更新され、起動済み Electron は古い dist を握り続ける。同じ瞬間に2インスタンスが動いていると「片方は新コード／片方は旧コード」になりうる。長期的には dev:electron も nodemon 的に再起動する仕組みが望ましい（今回はスコープ外）。
- **ハードキャップの保険は console.warn とセット**: サニタイザ側のバグ再発時にここで気付ける。silent truncate にしないこと。
- **Cursor Agent 並列 dispatch は有効**: A/B/D の 3タスクを並列で投げて 3/3 成功・所要約2分。独立性の高いコード変更に向く。

## 関連
- コミット: `e5c7247 fix: guard against LLM degenerate output and dev double-launch`
- 一時ログ: `/tmp/myloggy-fix-log.md`, `/tmp/myloggy-dispatch.log`, `/tmp/myloggy-task-{A,B,D}.md`（揮発性、再起動で消える）
- DB バックアップ: `~/Library/Application Support/Electron/myloggy-data/myloggy.sqlite.bak.20260506_233130`
- 関連スキル更新: `~/.claude/commands/app-development.md`（zsh 罠と並列 dispatch 手順を追記、commit `30245fd`）
