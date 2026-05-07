# myloggy — Claude Code コンテキスト

## プロジェクト概要

- **用途**: ローカル作業ログ自動化（画面キャプチャ → Ollama LLM → SQLite）
- **上流**: https://github.com/iritec/myloggy（MIT License、フォーク改修中）
- **案件区分**: **Albona 案件**

## 重要な制約

- **MW Notion・MW MEMORY.md への記録は禁止**（Albona と Morrow World は完全分離）
- 詳細な引き継ぎ情報は **`./HANDOFF.md`** を参照
- 仕様の正本は **`./docs/myloggy-spec-doc.md`**（Notion 公開済み）

## 公開済み Notion ページ

- URL: https://www.notion.so/myloggy-358f45ad182681e7bac4d6da8b9d04c8
- 親ページ ID: `358f45ad-1826-8057-93d3-d7d7cd885e1d`
- ローカルソース: `./docs/myloggy-spec-doc.md`
- 再投稿スクリプト: `./scripts/md-to-notion.py`

## 最短コマンド

```bash
# 起動
cd ~/myloggy && nohup npm run dev > /tmp/myloggy-dev.log 2>&1 &

# 停止
pkill -f "scripts/dev.mjs"; pkill -f "scripts/run-electron.mjs"; pkill -f "myloggy/dist-electron/electron/main.js"

# 状態確認
DB="$HOME/Library/Application Support/Electron/myloggy-data/myloggy.sqlite"
sqlite3 "$DB" "SELECT 'snap=' || (SELECT COUNT(*) FROM snapshots) || ' cp=' || (SELECT COUNT(*) FROM checkpoints) || ' wu=' || (SELECT COUNT(*) FROM work_units) || ' err=' || (SELECT COUNT(*) FROM error_logs);"
```

## 最重要注意事項

- 「保留:N」ボタン = `clearPendingSnapshots`（DELETE）。**誤タップ禁止**
- カーソル静止窓は `auto-idle` で休憩判定（LLM 不実行）
- `ELECTRON_RUN_AS_NODE` は VSCode/Cursor で常に 1 になる → `scripts/run-electron.mjs` で対処済み
- Notion トークンを repo にコミットしない（`HANDOFF.md` §5.4 参照）

## Cursor Agent 委譲ルール

コード編集は `/app-development` スキル経由で Cursor へ dispatch。詳細は `HANDOFF.md` §5.3 参照。

## 運用ログ記録ルール（試験運用中・必須）

このプロジェクトは試験運用中のため、**細かいことでも逐一記録を残す**。
セッション終了時 / トラブル対処後 / 仕様変更時には、`docs/operation-log/YYYY-MM-DD-<トピック>.md` を新規作成または追記する。

- **作成タイミング**: バグ調査・対処 / 仕様確認 / 設定変更 / 動作実績計測 / 新機能の試行 — 一過性の話題ならすべて
- **テンプレート**: `HANDOFF.md` §8.2（概要 / 経緯 / 原因 / 対応 / 学び・所感 / 関連）
- **粒度**: 細かくてOK。1セッション = 1ファイルが基本。複数トピックなら別ファイル
- **コミット**: 該当作業のコード変更と同じコミットに含めるか、ログ単独コミット
- **共有範囲**: Albona 内のみ（MW Notion 禁止）

セッション終了の手順では、本ルールに従って operation-log を残してから git push する。

## より詳しい情報

- 全体引き継ぎ → `./HANDOFF.md`
- 仕様詳細 → `./docs/myloggy-spec-doc.md`
- セットアップ手順 → `./SETUP.md`
- 運用ログ蓄積方針 → `./HANDOFF.md` §8
