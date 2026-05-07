# 2026-05-07 Visionモデル切替（gemma3:27b → qwen2.5vl:7b）

## 概要
キャプチャ画面が `[analysis] AbortError: This operation was aborted` を多発。原因は `gemma3:27b` が重く 5 分タイムアウト超過。軽量 Vision モデル `qwen2.5vl:7b` に切替。

## 経緯
- 11:32:13 Cursor アプリ画面（4 ペイン同時表示の高文字密度スクショ）をキャプチャ
- 11:45 解析失敗。エラーログに `AbortError` 記録
- ユーザーよりエラー報告
- `error_logs` テーブル直近 5 件中 5 件すべて同 `analysis` scope の AbortError（11:32〜15:43 の間）

## 原因
1. `gemma3:27b`（27.4B Vision）が Apple Silicon ローカル推論で遅い（ollama runner CPU time 12 分以上）
2. 解析対象画像の文字密度が極端に高い（Cursor 4 ペイン分割 ≒ 通常の数倍の OCR 負荷）
3. `analysisTimeoutMs=300000`（5 分）でも収まらない
4. `electron/core/llm.ts:256-257` の `AbortController.abort()` が発火 → `tracker-service.ts:399-403` が捕捉してエラー記録

## 対応
- `ollama pull qwen2.5vl:7b`（約 5GB、OCR 強い 7B Vision モデル）
- `~/Library/Application Support/Electron/myloggy-data/myloggy.sqlite` の settings.json を直接更新
  - `llmModel: "gemma3:27b" → "qwen2.5vl:7b"`
  - 旧設定は `/tmp/myloggy-settings-backup-20260507-120439.json` にバックアップ
- `pkill` → `nohup npm run dev` で再起動。Vite ready 444ms / TS errors 0
- 過去のエラーログ（5 件）は履歴として保持（クリアしていない）

## 学び・所感
- Apple Silicon × Ollama の現実的な Vision モデル上限は **7B** あたり。27B はバッチ運用なら可だが、1 分間隔キャプチャの即時解析には不向き
- 解析タイムアウト多発時は (a) モデル軽量化 (b) `excludedApps` で対象除外 (c) `analysisTimeoutMs` 延長 のいずれか。今回は (a) を選択
- DB 直書き換えは可能だがアプリ起動中は反映されない。要再起動 or アプリ内設定 UI 経由
- `defaults.ts` の既定値は `gemma3:27b` のまま。新規ユーザー/初期化時は再設定が必要

## 関連
- 既存 op-log: `docs/operation-log/2026-05-06-dual-instance-and-llm-loop.md`（gemma4 ループ問題で gemma3:27b 採用した経緯）
- 該当コード: `electron/core/llm.ts`, `electron/core/tracker-service.ts`, `electron/core/defaults.ts`
- 旧 HANDOFF.md §1.1 に「Ollama + gemma3:27b」と記載あり → モデル変更を反映する場合は別途更新検討

---

## 追記: num_ctx 不足によるOllama 500クラッシュ（同日発生）

### 概要
qwen2.5vl:7b 切替後、初回解析で `Ollama request failed with 500`。Ollama サーバログに RoPE assertion 失敗 → SIGABRT。

### 経緯
- 15:56 解析開始 → 1分25秒後に Ollama 500
- error_logs に `analysis | Ollama request failed with 500` 記録
- ollama.log に下記:

```text
WARN: truncating input prompt  limit=4096  prompt=19658  keep=4  new=3892
GGML_ASSERT(a->ne[2] * 4 == b->ne[0]) failed
SIGABRT: abort
```

### 原因
- Ollama デフォルト `num_ctx=4096` トークン
- 画像入りプロンプト = 約 19,658 トークン（5倍超）
- 切り詰め後、画像トークンの位置情報が不整合になり qwen2.5vl の RoPE で assertion 失敗 → runner が SIGABRT
- gemma3 系では既定 num_ctx が大きいため発覚していなかった

### 対応
- `electron/core/llm.ts` の `/api/generate` リクエスト options に `num_ctx: 32768` 追加
- アプリ再起動で反映（dev watcher 経由で自動ビルド）

### 学び・所感
- **Vision モデル切替時は `num_ctx` を必ず明示**。既定値はモデルごとに異なる
- 32768 トークンは qwen2.5vl の native max(128K) の 1/4。画像数増にも余裕あり
- `defaults.ts` に `num_ctx` を持たせて settings から制御可能にする方が将来性は高い（今回はベタ書き優先で見送り）

### 関連
- 同日上半分（モデル切替）と一連の流れ
- ollama.log 該当箇所: `/opt/homebrew/var/log/ollama.log` 2086 行目以降

---

## 追記2: analysisTimeoutMs を 5分 → 10分 に延長（同日発生）

### 概要
`num_ctx=32768` 適用後、Ollama runner はクラッシュしなくなったが、推論に5分超かかり Electron 側 `AbortController` が発火 → `analysis | This operation was aborted` 再発。

### 経緯
- 16:05 アプリ起動（num_ctx=32768 反映済）
- 16:05:54 Ollama runner 起動（KvSize:32768、メモリ 13.6 GiB）
- 推論中 → 5分到達 → AbortController が abort → Ollama 側も 500
- error_logs に `2026-05-07T07:10:54Z analysis "This operation was aborted"` 記録
- ollama.log: `[GIN] 16:10:54 | 500 | 4m59s | POST /api/generate`

### 原因
- qwen2.5vl:7b で `num_ctx=32768` のまま大きい画像入りプロンプト処理 → 推論時間が5分超
- `analysisTimeoutMs=300000` が短すぎた
- runner はクラッシュしていない（前回の RoPE assertion バグは解消済）

### 対応
- `~/Library/Application Support/Electron/myloggy-data/myloggy.sqlite` の settings.json を更新
  - `analysisTimeoutMs: 300000 → 600000`（5分 → 10分）
- 旧設定は `/tmp/myloggy-settings-backup-20260507-162103.json` にバックアップ
- アプリ再起動（16:21:20）

### 学び・所感
- `num_ctx` を上げるとコンテキスト処理時間がリニア以上に増える。タイムアウトとセットで考えるべき
- 1分間隔キャプチャ × 10分窓 = 最大10画像。文字密度高いスクショが続くと7〜10分は普通にかかる
- 画像数を `pickSnapshotsForLlm` で減らす方法もあるが、解析品質との trade-off。まずは時間を確保する方向

### 関連
- 同日上半分2件（モデル切替・num_ctx）と一連の流れ
- 次回監視: 16:31 頃の analyze サイクルで成功するか確認

---

## 追記3: 不明連発の構造修正 + メモリ圧対策（同日発生）

### 概要
タイムアウト延長してもまだ Ollama runner がサイレントクラッシュ（`fetch failed`、`5m2s`）→ macOS メモリ圧迫が原因。同時に「project_name/category がほぼ全件 不明」という構造的問題が判明したため、両方まとめて改修。

### 経緯
- 16:21 設定 600000ms で再起動
- 16:26 新エラー `analysis | fetch failed` / Ollama 500 / system memory free 882.9 MiB
- DB 統計: category=不明 71件 / 休憩 65件 / その他 0件、project_name=不明 123件
- 原因調査: `electron/core/llm.ts:299` で `category: UNKNOWN_LABEL` ハードコード、スキーマにも category 欠落、プロンプトに利用者プロファイル無

### 原因
1. **構造**: LLMにcategoryを生成させていない（コードで固定 不明）
2. **プロンプト**: ユーザー固有プロジェクト・カテゴリ判定基準なし → LLM がドメイン推測不能
3. **メモリ**: `num_ctx=32768` で qwen2.5vl の合計メモリ 13.6 GiB → system free 882 MiB → Ollama runner サイレントクラッシュ

### 対応（Cursor Agent dispatch 経由）
- `electron/core/llm.ts`:
  - `createCheckpointSchema` に `category` 追加
  - `sanitizeCategory(raw, settings)` 新設（settings.categories と完全/部分一致）
  - `buildPrompt` 日本語/英語ブロックに「利用者プロファイル」「カテゴリ判定基準」「category キー必須・値域制約」を追記
  - `analyzeWindow` で `category: UNKNOWN_LABEL` → `category: sanitizeCategory(parsed.category, settings)` に変更
  - `num_ctx: 32768 → 16384`（メモリ圧対策）
- `electron/core/llm-response.ts`:
  - `FIELD_ALIASES.category` 追加
  - `normalizeCheckpointLlmOutput` の戻り値に category 追加

### 学び・所感
- LLM分類アプリではプロンプトに「あなたの想定ユーザー像とプロジェクト群」を明示しないと精度が出ない（暗黙知を渡せ）
- カテゴリ判定もスキーマで固定キー化＋値域制約 が定石。zod default だけでは弱い
- `num_ctx` はメモリと推論速度のトレードオフ。Apple Silicon 24GB マシンで Vision モデル使う場合の上限感:
  - qwen2.5vl:7b @ num_ctx=32768 → 13.6 GiB（メモリ圧でクラッシュリスク）
  - qwen2.5vl:7b @ num_ctx=16384 → 多分 8〜10 GiB（安全圏）
- プロファイルは `electron/core/llm.ts` にベタ書き。将来は `defaults.ts` か `userProfile.json` に分離して settings UI から編集可能にしたい

### 関連
- 同日上記3件
- llm.ts 改修箇所: `sanitizeCategory`, `createCheckpointSchema`, `buildPrompt`, `analyzeWindow`

---

## 追記4: Vision画像数の上限削減（同日発生）

### 概要
カテゴリ・プロファイル追加でプロンプトが 23K トークンに肥大。`num_ctx=16384` でも足りず `truncating` 警告 → 約4分後に `fetch failed`（runner は生存だが応答停止）。画像枚数の根本削減で対処。

### 経緯
- 16:32:46 truncating warning prompt=23094 keep=4 new=15206
- 16:37:09 error_logs `analysis | fetch failed`（4分23秒経過）
- 16:37:20 別windowで再度 truncating prompt=23308
- Ollama runner 27906 は生存、ただし応答せず詰まり気味
- system memory free 2.5 GiB（前回より改善も依然タイト）

### 原因
- `MAX_VISION_IMAGES = 12`（最大12画像）が Vision トークンの主犯
- 画像1枚で qwen2.5vl が ~1500-2000 トークン消費（Image Token + 解像度依存）
- 12画像 = 18,000-24,000 トークン → 単独で num_ctx=16384 を埋め尽くす
- そこにテキストプロンプト（プロファイル追記分含む）が乗って 23K に

### 対応（Cursor Agent dispatch 経由）
- `electron/core/llm.ts` 冒頭の定数2つを変更
  - `MAX_SNAPSHOTS_FOR_LLM: 8 → 4`
  - `MAX_VISION_IMAGES: 12 → 3`
- 詰まっていた Ollama runner も `pkill -f "ollama runner"` で再起動
- アプリ再起動（16:45:46）

### 期待効果
- Vision トークン: 12画像 → 3画像 で 1/4 に削減（約 4,500-6,000 トークン）
- 合計プロンプト: 23K → ~10K トークン（num_ctx=16384 に余裕で収まる）
- メモリ圧も改善見込み

### 学び・所感
- Vision モデルの実用化には**画像枚数の慎重な絞り込み**が必須。「窓内全部送る」発想は LLM コンテキストとメモリの両方を圧迫
- 10分窓で4画像 = 2.5分間隔のサンプリング相当。判定精度への影響は要検証だが、画像3枚あれば「主作業の遷移」は捉えられる想定
- 将来は画像解像度のリサイズ（例: 768x768 リスケール）も併用検討余地あり

### 関連
- 同日4件目の対応
- 関連定数: `electron/core/llm.ts:17-19`

---

## 追記5: スリープ復帰耐性・retry・ウォームアップping・エラー分類精緻化

### 概要
画像数削減後、3件成功(`myloggy/開発/開発`)→ 約2.5h経過したところで「2-19秒で `client closing the connection` 連発」発生。原因はmacOSスリープ復帰直後の Ollama runner 未ロード状態への即時アクセス。多角的に堅牢化。

### 経緯（17:17〜19:18）
- 17:17 1件目abort (3m29s) — 直前にスリープ入った可能性
- 18:06, 18:24, 18:41, 18:58, 19:18 各回abort（2.2〜19秒）
- Ollamaログ: `aborting completion request due to client closing the connection` 連発
- ユーザーから「スリープしてたから取れてない可能性もありそう。多角観点で修正」依頼

### 原因
1. macOS スリープ中に Ollama runner が unload される
2. 復帰直後、tracker の setInterval が即座に analyze 発火 → runner 再ロード中（5-19秒）に Electron 側 fetch がタイムアウト/切断
3. retry 機構なし → 1回失敗で諦め、次サイクル(10分後)も同じ失敗を繰り返す
4. エラー分類が `analysis` 単一なので原因切り分けが困難

### 対応（Cursor Agent dispatch 経由）
A. **`powerMonitor` 連携**（`electron/main.ts`）
- `powerMonitor.on('suspend'|'resume')` を `tracker.onSuspend()/onResume()` に橋渡し

B. **TrackerService 拡張**（`electron/core/tracker-service.ts`）
- `isSuspended` / `analyzeSuppressedUntil` フラグ追加
- `onSuspend()`: フラグ立てて capture/analyze 即時停止
- `onResume()`: 60秒抑止 + ping → analyzeReadyWindows
- `start()` に起動時 ping 追加（runner pre-warm）
- `captureSnapshot` / `analyzeReadyWindows` 冒頭で suspend/抑止ガード
- catch ブロックで kind を細分化（`analysis:aborted` / `analysis:fetch_failed` / `analysis:runner_unloaded` / `analysis:http_5xx_quick` / `analysis:http_5xx_slow`）

C. **LLM クライアント retry**（`electron/core/llm.ts`）
- `pingOllama(settings, timeoutMs=30s)` 新設・export（軽量prompt `ok`、`num_predict:1`、`num_ctx:512`）
- `callOllamaWithRetry()` 新設: 1回目が30秒未満で失敗（HTTP 5xx or fetch 例外）したら 5秒wait → ping → 2回目試行
- AbortError は retry しない（10分タイムアウト到達は本物の失敗扱い）
- `analyzeWindow` 内の fetch を `callOllamaWithRetry` 経由に置換

### 学び・所感
- Vision LLM × ローカル推論はスリープ復帰問題が必発。`powerMonitor` 必須
- ウォームアップping は安いコスト（数百ms）で初回失敗を激減できる
- retry は「30秒未満の失敗」だけに絞ることで本物のtimeoutまで待たずに済む
- エラー分類は `scope` カラムを `analysis:<kind>` 形式にするだけで運用が劇的に楽になる

### 関連
- ファイル: `electron/core/llm.ts`, `electron/core/tracker-service.ts`, `electron/main.ts`
- 計 +181 / -31 行
- 監視: 19:32 再起動以降、10件連続成功でループ完了予定
