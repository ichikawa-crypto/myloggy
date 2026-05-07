# 2026-05-07 myloggy → Notion 同期スクリプト 初期構築

## 概要

myloggy が SQLite に蓄積する `work_units` を Notion に自動同期するパイプラインを実装した。

- Layer 1: 生データ蓄積 DB (`myloggy 作業ログ`)
- Layer 2: 日次集計＋Ollama 所感生成 DB (`myloggy 日次レポート`)
- 実行: launchd `StartInterval=10800` + `RunAtLoad=true`（PC 稼働中のみカウント）

## 経緯

| 時刻 | 操作 | 観察 |
|------|------|------|
| 設計フェーズ | Cursor (gpt-5.3-codex-high) で設計レビュー | 必須指摘 7 件・推奨指摘 6 件 → NO-GO 判定 |
| 設計 v2 | 必須 7 件すべて反映、推奨主要 4 件反映 | `docs/sync-to-notion-design.md` 確定 |
| Phase 0 | Albona Notion API で DB 2 つを直接 curl 作成（MCP 2025-09-03 では DB 作成未対応） | Layer 1: `359f45ad-1826-817c-9dff-efa2d24e33d2` / Layer 2: `359f45ad-1826-81a8-9dee-eaab5aa36132` |
| Phase 1-6 | `composer-2-fast` に dispatch（約20 分） | `sync_to_notion.py`（34 KB）+ plist + install/uninstall .sh 完成 |
| 初回テスト | dry-run → 本実行 → 冪等チェック | Layer 1: 56 件追加・1 件更新 / Layer 2: 2 日生成 / 再実行で 0 件追加 |
| Ollama 課題 | 当日分の所感が 120 秒タイムアウトで失敗 | retry_queue に追加、Layer 2 ページは作成（縮退運転 OK） |
| 修正 | `.env` に `OLLAMA_TIMEOUT_SECONDS=300` 追加 | 当日所感も生成成功（243 文字） |

## 原因

Ollama gemma3:27b は myloggy 本体でも 120 秒では vision 推論が間に合わず、`analysisTimeoutMs=300000` に DB レベルで延ばしていた（`HANDOFF.md §2.2 問題 B`）。

同期スクリプトの所感生成も同じく 120 秒では足りず、当日分（work_units が多くプロンプトが長い日）は確実にタイムアウトする。

## 対応

1. `~/myloggy/.env` に `OLLAMA_TIMEOUT_SECONDS=300` を追加
2. スクリプト側のデフォルトは 120 秒のままにし、上書き可能な仕様 (`int(env.get("OLLAMA_TIMEOUT_SECONDS", "120"))`)
3. retry_queue 機構があるので、タイムアウト発生時も次回実行で必ずリトライされる縮退設計

## 学び・所感

- **事前の Cursor レビューは効いた**: 必須 7 件のうち、特に「複合カーソル」「跨日按分」「parent 検証」「失敗時コミット境界」は実装後だと直しが大変。設計時点で潰せて良かった
- **Notion MCP 2025-09-03 は DB 作成不可**: 今後 DB 新規作成時は curl で 2022-06-28 を叩くのが確実
- **myloggy 本体の category 学習との関係**: 現状 Layer 1 の `カテゴリ` はほぼ "不明" になる。これは LLM 経路で `category='不明'` 固定の myloggy 本体仕様による。`category_rules` の蓄積が進めば自動的に解消する
- **launchd の `StartInterval` 方式**: 稼働中のみカウントなので 9-18 勤務 + MAX22 残業の業務リズムに自然にフィットした（「朝起動 → RunAtLoad → 12, 15, 18 → 必要なら21」）

## 関連

- 設計書: `docs/sync-to-notion-design.md`
- Cursor レビュー結果: 必須 7 / 推奨 6（全反映済み）
- Notion 公開ページ: https://www.notion.so/myloggy-358f45ad182681e7bac4d6da8b9d04c8
- Phase 2（Slack サマリー投稿）は未着手

## 追記: 運用監視ログの追加（2026-05-07）

- `logs/sync-history.log` を append-only で追加。1 実行 = 1 行のサマリー
- `scripts/sync_status.sh` で at-a-glance 確認可能に
- 日次の詳細ログは `logs/sync-YYYY-MM-DD.log` で継続
