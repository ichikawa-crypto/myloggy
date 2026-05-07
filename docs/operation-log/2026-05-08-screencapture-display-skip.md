# 2026-05-08 screencapture -D N 失敗時のディスプレイスキップ実装

## 概要
`screencapture -x -D 2 -t jpg ...` が「Command failed」で失敗し、
全モニター撮影モード（mode='all'）でループ全体がthrowしてAI処理失敗になる事象を修復。
1ディスプレイの失敗ではループを止めず、全滅時のみthrowする方針に変更。

## 経緯
- ユーザー環境: MacBook内蔵1枚のみ。外部ディスプレイ接続/切断が頻繁
- 撮影直前に外部ディスプレイが切断される、または `screen.getAllDisplays()` の戻り値と
  macOS側の `-D` インデックスの整合が一瞬ズレることがある
- 結果として `-D 2` が叩かれて失敗→`for...of` ループ全体がthrow→AI処理失敗ダイアログ

## 原因
`electron/core/capture.ts:32-37` の撮影ループに個別エラーハンドリングが無く、
1ディスプレイの失敗で全体がthrowする設計だった。
mode='main' は `-D 1` 固定で実害なし、問題は mode='all' のみ。

## 対応
- mode='all' のループ内で `execFile` + `fs.readFile` + `hashBuffer` + `push` を try/catch
- 失敗時は `console.warn('myloggy: capture skipped display N: <error>')` を出力してcontinue
- ループ後 `imagePaths.length === 0` なら `throw new Error('All display captures failed')`
- mode='main' の挙動は完全に従来通り（保護対象外）
- displayCount は既存仕様維持（実撮影数ではなく `screen.getAllDisplays().length` ベース）

## 学び・所感
- macOS `screencapture -D` のインデックスは Electron `screen.getAllDisplays()` の順番とは独立に管理される
- ホットプラグが頻繁な環境では撮影直前の整合性は信用しないほうが堅牢
- 「1枚でも撮れたら成功」のセマンティクスは LLM 後段に十分なコンテキストを残せる

## 関連
- ファイル: `electron/core/capture.ts`
- 上位エラーハンドラ: 「AI処理失敗」ダイアログ
- 依頼元: 2026-05-08 ユーザー報告（snap_824126c70cc9）
