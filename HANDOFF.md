# myloggy — チャット引き継ぎドキュメント

> 最終更新: 2026-05-06
> 目的: 本セッションの作業内容を構造化して残す。
> 使い方: 新しい Claude Code チャットを開いたとき、myloggy の運用・修正・ドキュメント継続のためにこのファイルを参照する。

---

## 1. 現在の状態（2026-05-07 時点）

### 1.1 動作状態

myloggy は**実用稼働可能な状態**まで構築済み。

- Ollama + **qwen2.5vl:7b**（Vision、num_ctx=16384、`MAX_VISION_IMAGES=3`、`MAX_SNAPSHOTS_FOR_LLM=4`）でローカル LLM 推論
- 1 分間隔キャプチャ → 10 分窓で自動分析（`analysisTimeoutMs=600000` = 10分）
- LLM 経由の checkpoint が **project_name + task_label + category** で日本語分類されることを実機検証済み
  - プロンプトに「市川さん固有プロジェクトプロファイル」+「6カテゴリ判定基準」埋め込み
- スリープ復帰耐性 + retry + ウォームアップping + エラー分類の堅牢化済み（`powerMonitor`、`pingOllama`、`callOllamaWithRetry`）
- DB: `~/Library/Application Support/Electron/myloggy-data/myloggy.sqlite`

#### モデル切替の経緯（2026-05-07）

`gemma3:27b` ではタイムアウト多発・推論遅延。`qwen2.5vl:7b` に切替後、複数の二次問題（num_ctx, メモリ圧, 不明連発, スリープ復帰）に対処。詳細は `docs/operation-log/2026-05-07-vision-model-switch.md`（5セクション、追記1〜5）。

### 1.2 起動状態

`npm run dev` でターミナル依存運用中（永続化はまだ）。

```bash
# 起動確認
ps aux | grep "myloggy/dist-electron" | grep -v grep
```

---

## 2. これまでにやったこと

### 2.1 Phase 1: 環境構築

| Step | 内容 | 状態 |
|------|------|------|
| 1 | `brew install ollama` + サービス起動 | ✅ |
| 2 | `ollama pull gemma3:27b`（17 GB） | ✅ |
| 3 | `git clone iritec/myloggy ~/myloggy` + `npm install` | ✅ |
| 4 | macOS 画面収録 + アクセシビリティ権限付与 | ✅ |
| 5 | `npm run dev` 起動確認 | ✅ |

### 2.2 遭遇した問題と修正（4 件）

| # | 問題 | 原因 | 修正先 |
|---|------|------|-------|
| A | Electron が起動直後にクラッシュ（`app is undefined`） | VSCode/Cursor が `ELECTRON_RUN_AS_NODE=1` を継承させる | `scripts/run-electron.mjs`（新規）、`scripts/dev.mjs`、`package.json` |
| B | LLM 分析が全件タイムアウト | `analysisTimeoutMs=120000` が短すぎる | DB 内 settings を 300000 に手動更新 |
| C | LLM 出力が「ext-ext-ext...」ループ・JSON 切れ | gemma4 の品質 + 巨大ペイロード | `electron/core/llm.ts`（サンプリング・options）、`electron/core/llm-response.ts`（寛容パース）、`electron/core/defaults.ts`（既定 gemma3:27b に） |
| D | 「今すぐAI処理」ボタンが見えない | 狭幅で flex 折り返し + オンボーディング未完了時の UI | `src/styles.css`、`src/App.tsx`、`src/i18n.tsx` |

### 2.3 ドキュメント整備

| ファイル | 役割 |
|---------|------|
| `~/myloggy-dev-spec.md` | 旧版の技術メモ（一部現行コードと不一致あり）。**実態は `docs/myloggy-spec-doc.md` と実コードを正とする** |
| `~/myloggy/SETUP.md` | セットアップ手順書 |
| `~/myloggy/CLAUDE.md` | Claude Code 用コンテキスト（自動読込） |
| `~/myloggy/HANDOFF.md` | 本ファイル（引き継ぎ用） |
| `./docs/myloggy-spec-doc.md` | Notion 公開資料のローカルソース（**正本**） |

### 2.4 Notion 投稿

- **公開ページ**: https://www.notion.so/myloggy-358f45ad182681e7bac4d6da8b9d04c8
- 親ページ: 作業ログシステム仕様確認（Albona、ID `358f45ad-1826-8057-93d3-d7d7cd885e1d`）
- 構成: 8 章（再投稿のたびにブロック数は変動）
- 投稿スクリプト: `~/myloggy/scripts/md-to-notion.py`（再利用可能、repo 配下）

### 2.5 レビュープロセス記録

ドキュメント仕上げは Cursor Agent との**6 ラウンドレビューループ**で品質保証。判定基準:
- 必須指摘ゼロ（事実誤認・セキュリティ問題なし）
- 推奨指摘も極力反映
- 危険コマンド・トークン平文記載なし

| Round | 必須指摘 | 推奨指摘 | 結果 |
|-------|---------|---------|------|
| 1 | 5 | 5 | 全反映 |
| 2 | 2 | 3 | 全反映 |
| 3 | 1 | 3 | 全反映 |
| 4 | 0 | 0 | 通過 |
| 5 | 2 | 3 | 全反映 |
| 6 | 0 | 3（任意） | 公開可 |

第 7 章（集約方式）を Notion/Slack 文脈に書き直した後にも 2 ラウンド追加実施。
本引き継ぎ資料も Cursor で必須指摘ゼロまで詰めた上で確定。

---

## 3. 未対応・今後の検討事項

### 3.1 短期（次セッションで取り組む候補）

| # | タスク | 概要 |
|---|-------|------|
| 1 | `src/i18n.tsx` の旧「Gemma 4」表記クリーンアップ | `installModelDescription` 等に残存。ドキュメントには残存ありと正直に記載済み |
| 2 | `electron/core/defaults.ts` の `analysisTimeoutMs` をコードレベルで 300000 に変更 | 現状は DB 設定のみ更新。新規インストールでは 120000 のまま |
| 3 | 初回キャプチャを起動直後に走らせるか検討 | 仕様上は 1 分後だが、UX 的には起動即キャプチャが良い場合あり |

### 3.2 中期（Albona チームで検討）

| # | タスク | 概要 |
|---|-------|------|
| 4 | **Notion DB 同期実装**（仕様確認資料 §7.3 参照） | work_units を Notion DB に upsert する Python/Node スクリプト |
| 5 | **Slack 日次/週次サマリー投稿実装**（§7.4 参照） | Incoming Webhook で投稿 |
| 6 | カテゴリの組織共通化 | `shared/localization.ts` の `CATEGORY_DEFINITIONS` を Albona 業務に合わせて拡張 |
| 7 | `.dmg` ビルド + 配布 | `pnpm dist:mac:prod:arm64` でビルド、ログイン項目登録で常時稼働 |

### 3.3 長期（必要時）

| # | タスク | 概要 |
|---|-------|------|
| 8 | upstream への PR | 特に `ELECTRON_RUN_AS_NODE` 対策は環境問題への汎用解として PR 価値あり |
| 9 | フォーク管理 | upstream 更新時の手動マージ運用 |

---

## 4. 既知の注意点・落とし穴

| 項目 | 内容 |
|------|------|
| 「保留:N」ボタン | クリックで `clearPendingSnapshots`（DELETE）が走る。誤タップ禁止 |
| カーソル静止窓 | `auto-idle` 判定で LLM 未実行。「今すぐAI処理」ボタンも効かない（仕様） |
| Notion 投稿後の編集 | 投稿後にユーザーが Notion 上で直接編集することがある。再投稿時は差分確認が必要 |
| `docs/myloggy-spec-doc.md` §1.3 テーブル | 現行 Notion ページではローカル markdown と一部表記が異なる箇所がある（ユーザーが Notion 上で直接編集した経緯あり）。再投稿前に Notion 現物との差分確認推奨 |
| `ELECTRON_RUN_AS_NODE` | VSCode/Cursor 環境で常に 1 になる。修正済みだが他のプロジェクトでも要注意 |

---

## 5. よく使うコマンドまとめ

### 5.1 動作確認

```bash
# Electron プロセス
ps aux | grep "myloggy/dist-electron" | grep -v grep

# Ollama
curl -s http://127.0.0.1:11434/api/tags | python3 -m json.tool

# DB スナップショット集計
DB="$HOME/Library/Application Support/Electron/myloggy-data/myloggy.sqlite"
sqlite3 "$DB" <<'EOF'
SELECT
 (SELECT COUNT(*) FROM snapshots) AS snap,
 (SELECT COUNT(*) FROM snapshots WHERE status='processed') AS proc,
 (SELECT COUNT(*) FROM checkpoints) AS cp,
 (SELECT COUNT(*) FROM checkpoints WHERE llm_model NOT LIKE 'auto-%') AS llm_cp,
 (SELECT COUNT(*) FROM work_units) AS wu,
 (SELECT COUNT(*) FROM error_logs) AS err;
EOF

# 最新 work_units
sqlite3 "$DB" "SELECT substr(start_at,12,5)||'-'||substr(end_at,12,5),duration_minutes,category,project_name,title FROM work_units ORDER BY start_at DESC LIMIT 10;"
```

### 5.2 起動・停止・再起動

```bash
# 起動
cd ~/myloggy && nohup npm run dev > /tmp/myloggy-dev.log 2>&1 &

# 停止
pkill -f "scripts/dev.mjs"; pkill -f "scripts/run-electron.mjs"; pkill -f "myloggy/dist-electron/electron/main.js"

# 設定変更（タイムアウト等）
sqlite3 "$DB" "UPDATE settings SET json = json_set(json, '\$.analysisTimeoutMs', 300000), updated_at = datetime('now') WHERE id = 1;"
```

### 5.3 Cursor Agent 委譲

コード編集時:
```bash
echo "実装内容..." > /tmp/task.txt
python3 ~/claude-cursor-orchestration/src/cursor_dispatch.py "$(cat /tmp/task.txt)" --workspace ~/myloggy --model composer-2-fast
```

レビュー時:
```bash
python3 ~/claude-cursor-orchestration/src/cursor_dispatch.py "$(cat /tmp/review.txt)" --workspace ~/myloggy --model gpt-5.3-codex-high
```

セッションログ: `~/claude-cursor-orchestration/src/logs/session_*.jsonl`

### 5.4 Notion 再投稿

⚠️ **Notion トークンは絶対にコミット・共有しないこと**（過去のチャットログに平文流出履歴があるため、必要に応じてトークンを再発行）。

トークンは Albona Notion Integration の管理画面で発行し、`~/.claude.json` などのローカル設定から `claude mcp list` 経由で参照する。

```bash
# 環境変数でトークンを設定（ローカルでのみ）
export NOTION_TOKEN="<Albona Notion Integration トークン>"
export PARENT_ID="358f45ad-1826-8057-93d3-d7d7cd885e1d" # 親ページ
export MD_PATH="/Users/takehiroichikawa/myloggy/docs/myloggy-spec-doc.md"

# 既存ページをアーカイブ
PAGE_ID="<現行ページID>"
curl -s -X PATCH "https://api.notion.com/v1/pages/$PAGE_ID" \
 -H "Authorization: Bearer $NOTION_TOKEN" \
 -H "Notion-Version: 2022-06-28" \
 -H "Content-Type: application/json" \
 -d '{"archived": true}'

# 新版投稿
python3 ~/myloggy/scripts/md-to-notion.py
```

---

## 6. 参考リンク

- 上流リポジトリ: https://github.com/iritec/myloggy
- 公開 Notion ページ: https://www.notion.so/myloggy-358f45ad182681e7bac4d6da8b9d04c8
- **仕様の正本**: `./docs/myloggy-spec-doc.md`（Notion ソース）
- セットアップ手順: `./SETUP.md`
- 旧版・参考: `~/myloggy-dev-spec.md`（一部現行コードと不一致あり、参照時は注意）

---

## 7. 引き継ぎ時のおすすめ動作

新しいチャットを始めたら、以下の順で context を取得すると話が早い：

1. `~/myloggy/CLAUDE.md` を確認（短く本質、自動読込）
2. このファイル（`HANDOFF.md`）で詳細把握
3. 必要なら `./docs/myloggy-spec-doc.md` を参照（正本）
4. 状態確認コマンドで現環境を把握（§5.1）

ユーザーから具体的な要望が来たら、§3 の未対応リストと照らして優先度判断。

---

## 8. 運用ログドキュメント（今後の蓄積想定）

myloggy を実際に運用してみての気づき・改善・トラブル事例を**継続的にログ化**するためのテンプレートとフォーマット。

### 8.1 ログ蓄積方針

| 項目 | 方針 |
|------|------|
| 保存場所 | `~/myloggy/docs/operation-log/` 配下に時系列で（推奨ファイル名: `YYYY-MM-DD-<トピック>.md`） |
| 集約版 | `~/myloggy/docs/OPERATION-LOG.md` に四半期ごとに索引化 |
| Notion 同期 | 親ページ「作業ログシステム仕様確認」配下に「運用ログ」サブページを作って週次/月次でまとめ投稿 |
| 共有範囲 | Albona 内（MW Notion 禁止） |

### 8.2 ログエントリのテンプレート

```markdown
# YYYY-MM-DD <トピック>

## 概要
（何が起きたか、何を試したか、を 1〜3 行で）

## 経緯
- 時刻 / 操作 / 観察結果

## 原因（判明した場合）
（なぜ起きたか）

## 対応
（実施した修正・回避策。コード変更があればコミットハッシュも）

## 学び・所感
（次回どうするか、他の運用者が知るべきこと）

## 関連
- Notion ページ / GitHub Issue / Slack スレ等
```

### 8.3 蓄積を推奨するトピック例

| カテゴリ | 例 |
|---------|----|
| 動作実績 | 「1 ヶ月運用してみての DB サイズ・推論速度の実測」 |
| 不具合 | 「Electron が起動失敗した時の対処」「LLM が誤判定した事例」 |
| 改善 | 「カテゴリ追加・命名規則の調整」「閾値調整（idleGapMinutes 等）」 |
| 運用 | 「他のメンバーへの展開時の困りごと」「.dmg 配布の手順実績」 |
| 連携 | 「Notion DB 同期実装の試行錯誤」「Slack サマリーのフォーマット改善」 |

### 8.4 運用ログを書くタイミング

- 仕様確認資料（`docs/myloggy-spec-doc.md`）に**書ききれない一過性の話**が出たとき
- トラブル発生時（その日のうちに）
- 月次振り返り（毎月初）
- 新メンバーへの展開前後

### 8.5 仕様資料との使い分け

| 種別 | ファイル | 内容 |
|------|---------|------|
| 仕様（不変） | `docs/myloggy-spec-doc.md` | 仕様・既定値・既知の制約 |
| 運用（時系列） | `docs/operation-log/*.md` | 実際の運用での気づき・対処 |
| 引き継ぎ（環境固有） | `HANDOFF.md`、`CLAUDE.md` | 現状・未対応・コマンド集 |

運用ログから繰り返しパターンが見えてきたら、仕様資料 or HANDOFF.md に昇格させる運用を想定。
