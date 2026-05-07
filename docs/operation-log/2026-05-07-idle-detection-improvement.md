# 2026-05-07 idle判定改善（除外アプリ + 画面ハッシュ安定性）

## 概要

`isIdleWindow()` が「マウスカーソルが2連続スナップショットで1px以下しか動かなければ即休憩」というロジックだったため、Cursor Agent / Claude Code に指示してエージェント作業を見守っている時間（マウス静止だが画面はストリーミング更新）が誤って休憩に分類される問題があった。

実DB（`snapshots` テーブル直近20件）で確認: cursor=(317, 839) で連続静止しているのに `image_hash` は b6b41161 → bddac384 と変化（画面内容が変わっているがマウスは触っていない、典型的なエージェント監視状態）。

## 経緯

1. ユーザーから「Cursorで指示してると休憩判定される」報告
2. `tracker-service.ts:264 isIdleWindow()` を特定。LLMを通さず即 category='休憩' / llmModel='auto-idle' で確定する設計
3. 設計選択肢を3つ整理（①除外アプリ ②画面ハッシュ差分 ③キーストローク追加）
4. ユーザーが「①+②」を選択

## 原因

- カーソル位置のみで判定する単一シグナル設計
- Cursor Agent / Claude Code 利用時は「マウス静止 + 画面動的」というシグナルパターンになるが、これを区別できない
- `keyboardActivity` / `mouseActivity` フィールドは型に存在するが metadata.ts では常に null（取得未実装）

## 対応

3条件AND判定に拡張:
1. **除外アプリ**: `idleExcludedApps` のいずれかが activeApp と部分一致したら idle 扱いしない（既定: Cursor / Code / Visual Studio Code / Claude / iTerm2 / Terminal / Warp / Ghostty / Alacritty / Hyper）
2. **画面ハッシュ安定性**: `idleRequireStableImage=true` のとき、ウィンドウ内の `imageHash` が一度でも異なれば idle 扱いしない
3. **カーソル静止**（従来）: 全スナップショットで cursorX/Y が ±1px 以内

### 変更ファイル
- `electron/core/idle.ts` 新規 — `isIdleWindow(snapshots, settings)` を純粋関数として抽出
- `electron/core/idle.test.ts` 新規 — node:test で7ケース
- `shared/types.ts` — `AppSettings` に `idleExcludedApps`, `idleRequireStableImage` 追加
- `electron/core/defaults.ts` — 既定値追加
- `electron/core/tracker-service.ts` — 旧privateメソッド削除、import差し替え、`normalizeSettings` で後方互換フォールバック
- `package.json` — `npm test` script に `idle.test.ts` を追加

### 検証
- `npx tsc --noEmit`: エラーなし
- `npm test`: 12/12 パス（既存5＋新規7）

## 学び・所感

- 「単一シグナルで決め打ちする最適化」はコストは安いが、ユースケース分布が変わると壊れる。Cursor Agent / Claude Code が日常になった結果「マウス静止＝離席」前提が崩れた典型例
- pure function 化＋ `(input, settings) => result` シグネチャ化により、設定駆動でシグナルを足し引きしやすい構造に変更できた。今後 keyboardActivity 取得実装が入れば同じファイルに条件追加するだけで済む
- `imageHash` は sha256(JPG) なので、メニューバー時計の秒更新やカーソル点滅でも変化する。「離席＝画面完全凍結」は厳しすぎる仮定だが、idle判定をスキップする側に倒すフェイルセーフなので問題は出にくい想定。誤判定でLLM呼び出しが増えても、LLMが正しく「休憩」と分類できれば結果は同じ
- 設定UIは未実装。除外アプリリストの調整は当面 SQLite の settings JSON 直接編集

## 関連

- 該当コード: `electron/core/idle.ts`, `electron/core/tracker-service.ts:411`
- 上流：オーケストレーション = Claude Code（設計） → Cursor Agent（実装）/ composer-2-fast / dispatch session ad3fcbfa-486e-445c-8026-ee369bf6f928
- 既存 op-log: `2026-05-07-vision-model-switch.md`（同日のVisionモデル切替）
