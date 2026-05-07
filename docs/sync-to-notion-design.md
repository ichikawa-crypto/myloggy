# myloggy → Notion 同期 設計書 v2

> 最終更新: 2026-05-07
> 案件: Albona（MW 分離）
> ステータス: 設計確定（Cursor レビュー必須指摘 7 件 + 推奨指摘反映済み） → 実装フェーズへ

---

## 1. ゴール

myloggy が SQLite に蓄積する作業実績を Notion に**全自動**で同期する。Slack 連携は次フェーズ。

- **作業ログ（Layer 1）**: `work_units` 1 件 = 1 レコード。生データの蓄積。機械が書く・触る領域
- **日次レポート（Layer 2）**: 1 日 = 1 レコード。集計＋所感（Ollama 自動生成）。機械が書く・触る領域
- 人の手編集は想定しない（Slack で振り返り共有が主用途）
- 作業ログとレポートは責務を完全に分離する

---

## 2. 全体構成

```
SQLite (work_units)
   │
   │ 差分 upsert（複合カーソル方式）
   ▼
┌────────────────────────────┐
│ Layer 1: 作業ログDB         │
│ 1 work_unit = 1 row        │
└──────────────┬─────────────┘
               │ 影響日付を集計
               ▼
┌────────────────────────────┐
│ Layer 2: 日次レポートDB     │
│ 1 day = 1 row              │
│ 所感は Ollama gemma3:27b   │
└────────────────────────────┘
```

---

## 3. Notion DB スキーマ

### 3.1 Layer 1: `myloggy 作業ログ`

親ページ: `358f45ad-1826-8057-93d3-d7d7cd885e1d`（myloggy 公開ページ）

| プロパティ | 型 | 元データ | 備考 |
|-----------|-----|---------|------|
| タイトル | title | `work_units.title` | |
| 開始 | date | `start_at` | JST |
| 終了 | date | `end_at` | JST |
| 工数h | number | `duration_minutes / 60` | 小数 2 桁 |
| カテゴリ | select | `category` | プリセット: 広告運用 / SEO / コンテンツ制作 / データ分析 / MTG / 事務作業 / 休憩 |
| プロジェクト | rich_text | `project_name` | select だとカーディナリティ爆発するため text |
| サマリー | rich_text | `summary` | |
| ユーザー編集済み | checkbox | `user_edited` | |
| 同期キー | rich_text | `work_units.id` | **不変一意キー**（upsert キー） |
| 更新カーソル | rich_text | `updated_at\|work_unit_id` | 複合カーソル比較用 |
| 最終同期 | date | スクリプト実行時刻 | |

### 3.2 Layer 2: `myloggy 日次レポート`

| プロパティ | 型 | 内容 |
|-----------|-----|------|
| 日付 | title | `2026-05-07` |
| 日付(date) | date | filter / sort 用 |
| 同期キー | rich_text | `daily:2026-05-07:Asia/Tokyo`（**不変キー**） |
| 合計工数h | number | 当日 work_units 合計（按分後） |
| カテゴリ内訳 | rich_text | `広告運用: 2.5h / SEO: 1.5h / MTG: 0.5h` |
| 主要プロジェクト | rich_text | TOP3 |
| 休憩時間h | number | category=休憩 合計 |
| 作業ログ | relation → Layer1 | 当日の work_units 全部 |
| 所感 | rich_text | Ollama 生成 |
| 所感モデル | rich_text | `gemma3:27b` |
| 所感プロンプトVer | rich_text | `v1` |
| 所感生成日時 | date | |
| 確定済み | checkbox | 前日以前=true、当日=false |
| 生成日時 | date | スクリプト実行時刻 |

---

## 4. 同期ロジック

### 4.1 差分抽出（必須 #1 対応）

```sql
WHERE (updated_at, id) > (last_cursor_updated_at, last_cursor_id)
ORDER BY updated_at ASC, id ASC
```

複合カーソル + tie-breaker で同一タイムスタンプの取りこぼしを排除。

### 4.2 冪等性（必須 #2 対応）

upsert 時の page_id 解決順序:

1. ローカル `sync_state.json` の `id_map` を引く
2. ヒットしなければ Notion で `同期キー = work_units.id` を query
3. それでも無ければ `pages.create`、見つかれば `pages.update`

`sync_state.json` の書き込みは tmp + atomic rename（fsync）。

### 4.3 排他制御（必須 #3 対応）

`~/myloggy/data/sync.lock` に `fcntl.flock(LOCK_EX | LOCK_NB)`。取得失敗 → 即終了（多重起動スキップ）。

### 4.4 跨日按分（必須 #4 対応）

- TZ: **Asia/Tokyo 固定**
- 跨日 work_unit は `[start, 24:00)` と `[00:00, end)` に分割し各日にカウント
- Layer 1 は元レコードそのまま（按分は集計時のみ）
- Layer 2 の `合計工数h` `カテゴリ内訳` `主要プロジェクト` `休憩時間h` は按分後で算出

### 4.5 Layer 2 upsert キー（必須 #5 対応）

不変キー `daily:YYYY-MM-DD:Asia/Tokyo` を `同期キー` プロパティに保持。タイトル文字列に依存しない。

### 4.6 失敗時のコミット境界（必須 #6 対応）

`sync_state.json` 拡張:

```json
{
  "schema_version": 1,
  "last_cursor": {"updated_at": "...", "id": "..."},
  "layer1_synced_ids": ["uuid1", "uuid2", "..."],
  "layer2_pending_dates": ["2026-05-07", "..."],
  "id_map": {"work_unit_id": "notion_page_id", "...": "..."},
  "ollama_retry_queue": ["2026-05-07", "..."]
}
```

進行ルール:

- Layer 1 成功 → 該当 ID を `layer1_synced_ids` に追加、`last_cursor` 更新（**state 保存時に当該リストは直近 1000 件にトリム** — 監査用のみで同期ロジックは id_map 依存）
- Layer 1 で影響を受けた日付を `layer2_pending_dates` に追加
- Layer 2 成功 → 該当日付を `layer2_pending_dates` から除去
- Ollama 失敗時 → Layer 2 ページ自体は作成（所感空欄）、`ollama_retry_queue` に追加 → 次回実行で再生成

### 4.7 Albona 誤送信防止（必須 #7 対応）

起動直後（**`--dry-run` を含む全モード**）に以下を検証し、一致しなければ即停止（`CRITICAL` ログ + 終了）:

1. `NOTION_PARENT_PAGE_ID`（`.env` またはシェルで上書き）がハードコード正 `358f45ad-1826-8057-93d3-d7d7cd885e1d` と**文字列完全一致**すること
2. `NOTION_TOKEN` で `GET /v1/pages/{EXPECTED_PARENT_PAGE_ID}` が成功し、ページ ID が一致すること
3. **`GET /v1/databases/{NOTION_DB_WORK_LOG}` / `...DAILY_REPORT...` で各 DB の `parent.type == page_id` かつ `parent.page_id` が上記公開ページ ID と一致すること**（DB が別ワークスペース／別親に置かれた設定ミスを検出）

### 4.8 所感生成

- 当日（`確定済み=false`）: 毎実行で再生成・上書き
- 前日以前（`確定済み=true`）: **凍結**。再生成しない（履歴の安定性確保）
- **凍結フォールバック**: 既存ページがある前日以前の日で `GET /v1/pages/{id}`（プロパティ取得）が失敗した場合、**所感関連 4 プロパティ（所感／所感モデル／所感プロンプトVer／所感生成日時）は PATCH から除外**し、空上書きを防ぐ（`WARNING` ログ）
- Ollama 失敗時: Layer 2 は作るが所感空欄、retry_queue で次回再試行

プロンプト（v1）:

```
以下は{YYYY-MM-DD}の作業ログです。3-4文で振り返り所感を生成してください。
- 何に時間を使ったか
- 特徴的な動きや傾向
- 改善の余地

{work_units リスト}
```

---

## 5. スケジューリング

### 5.1 launchd 設定

`~/Library/LaunchAgents/com.myloggy.synclog.plist`

| 設定 | 値 |
|------|-----|
| `StartInterval` | 10800（3 時間） |
| `RunAtLoad` | true |

### 5.2 想定稼働パターン（勤務時間 9-18 / MAX22）

```
9:00  起動 → RunAtLoad で1回
12:00 → 15:00 → 18:00 → (21:00 残業時)
PCシャットダウン → 翌9:00 起動 → RunAtLoad で前日確定処理
```

`StartInterval` 方式のため PC 稼働中だけカウント。寝てる時間はスキップ → 起動時に追いつく。

### 5.3 初回起動フック

スクリプト先頭で **「`layer2_pending_dates` の中で日付が今日より前のもの」を確定モード（`確定済み=true`）でまとめて生成**。

前日 23:55 の work_unit があっても翌朝の起動で確実に締まる。

---

## 6. ファイル構成

```
~/myloggy/
├── scripts/
│   └── sync_to_notion.py            # 本体
├── data/
│   ├── sync_state.json              # 状態（gitignore）
│   └── sync.lock                    # 排他ロック
├── logs/
│   └── sync-YYYY-MM-DD.log          # 日次ローテ
└── .env                             # NOTION_TOKEN（gitignore）

~/Library/LaunchAgents/
└── com.myloggy.synclog.plist
```

---

## 7. 縮退運転とエラーハンドリング

| 障害 | 挙動 |
|------|------|
| Notion API 429 | `Retry-After` 尊重で指数バックオフ。3 回失敗で当該レコードスキップ＋ログ |
| Notion API 5xx | 同上 |
| Ollama 不通 | Layer 1 は完遂。Layer 2 は所感空欄で作成、retry_queue 追加 |
| SQLite ロック | リトライ 3 回後スキップ |
| parent / DB 親検証失敗 | 即停止、`logs/sync-*.log` に CRITICAL 記録 |
| 多重起動 | flock 失敗で静かに終了 |
| `sync_state.json` 破損 | バックアップ（`.bak`）からロード、なければ Notion 全件 query で再構築 |
| `sync_state.json` 書き込み失敗 | `StateSaveError` として終了（`reason=state_save_failed`） |
| **id_map の page_id が Notion 上 404**（削除・移動後） | **自己修復**: `id_map` から当該キーを削除して保存 → 同期キーで再 query → ヒット時は再 PATCH、非ヒット時は **1 回だけ** `pages.create` にフォールバック |
| **Layer 1 の一部レコード失敗** | **処理は継続**。`last_cursor` は「先頭の失敗行より前」の成功分までしか進めない（取りこぼし再試行用）。サマリー `L1 partial failures` をログ |
| 部分同期失敗の終了コード | 履歴は `FAIL` 記録。既定は **exit 0**（launchd 短周期ループ回避）。**`STRICT_EXIT_CODE=true`** のときのみ `errors` / `ollama_fail` で **exit 1** |

Layer 2 の `作業ログ` relation は **最大 100 件**（超過分は切り捨て・WARNING）。通常時の日次集計は `layer2_pending_dates`＋当日＋ retry 対象日に限定した SQLite 読み込みで行い、**`--backfill` 指定時のみ** work_units 全件スキャン。

---

## 8. セキュリティ

- `NOTION_TOKEN` は `~/myloggy/.env`、repo にコミット禁止（HANDOFF.md 5.4）
- `.env` は `.gitignore` 確認
- 起動時に `.env` の mode を確認し、group/other に読み取りがある場合は **WARNING**（実行は継続、`chmod 600` 推奨）
- ログには token・SQL 生データを記録しない
- 外部送信先は Notion API のみ。Ollama はローカル

---

## 9. 実装順序（Phase 0-8）

| Phase | 内容 |
|-------|------|
| 0 | DB 2 つを Notion に作成（手動 or API）、parent 検証ロジック確認 |
| 1 | `sync_state.json` スキーマ + flock + atomic write |
| 2 | SQLite 差分抽出（複合カーソル）+ Layer 1 upsert |
| 3 | 跨日按分ロジック + Layer 2 集計 |
| 4 | Ollama 所感生成 + retry_queue |
| 5 | 縮退運転とエラーハンドリング |
| 6 | launchd plist + 初回起動フック |
| 7 | 1 日運用テスト → ログ確認 |
| 8 | 本格運用（Slack フェーズへ引き継ぎ） |

---

## 10. 次フェーズ（Phase 2 想定）

- Slack 日次サマリー投稿（Incoming Webhook or `chat.postMessage`）
- Layer 2 を素材として整形して投稿
- 投稿先・時刻・粒度は別途設計

---

## 11. 反映済みのレビュー指摘

### Cursor 必須指摘（全 7 件反映）

| # | 指摘 | 反映箇所 |
|---|------|---------|
| 1 | 増分抽出の取りこぼし | §4.1 複合カーソル方式 |
| 2 | 冪等性の単一障害点 | §4.2 Notion query フォールバック + atomic write |
| 3 | 排他制御未定義 | §4.3 flock |
| 4 | 跨日ルール未定義 | §4.4 JST 固定 + 分割按分 |
| 5 | Layer 2 upsert キー可変 | §4.5 不変同期キー |
| 6 | 失敗時コミット境界 | §4.6 state 拡張 |
| 7 | Albona 誤送信防止 | §4.7 parent 検証 |

### Cursor 推奨指摘（主要 4 件反映）

| 指摘 | 反映 |
|------|------|
| プロジェクト select の高カーディナリティ | §3.1 rich_text に変更 |
| 所感の履歴揺れ | §4.8 前日以前は凍結 + モデル/プロンプトVer 記録 |
| Ollama 障害時の縮退 | §7 Layer 1 完遂 + retry_queue |
| ログローテ | §6 日次ローテ |

---

*本設計書は Cursor Agent (gpt-5.3-codex-high) のレビュー結果（必須 7 / 推奨 6）を反映済み。実装は `/app-development` で Cursor Agent に dispatch する。*
