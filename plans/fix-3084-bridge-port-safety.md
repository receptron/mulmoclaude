# fix(bridges): 受信ポートの読み取りと bind を安全側に倒す (#3084)

PR-A（本プラン）= 受信型 9 個のポート。PR-B（別プラン / 別 PR）= 25 個のプロセス堅牢化。
issue の D-4 の選択肢 (b) を採る — 触るファイルも revert 単位も違う。

## 現状（測った事実）

| 対象                                          | 件数  | 証跡                                                                                                                       |
| --------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------- |
| `Number(process.env.X) \|\| N` で listen する | 9     | `line:23` `whatsapp:23` `messenger:20` `google-chat:26` `teams:29` `webhook:33` `twilio-sms:36` `line-works:38` `viber:27` |
| `app.listen` の `error` ハンドラ              | 0 / 9 | `grep -n "\.listen(" packages/bridges/*/src/*.ts`                                                                          |

`Number(x) || N` の 3 つの穴:

- `302a` → `NaN` → falsy → 既定で起動（打ち間違いが黙殺される）
- `0` → falsy → 既定で起動（`PORT=0` = OS に空きを選ばせる、が指定できない）
- `99999` → 範囲検証なしで `listen` に渡る

## 決定（issue の D-1〜D-3, D-6）

- **D-1 `asInt` の家 = `@mulmoclaude/common`**。依存ゼロの leaf、description が
  "shared across the MulmoClaude host, bridges, and plugins"、`build:packages` の最初にビルド、
  そして `@mulmobridge/client` 自身が既に common に依存（族をまたぐ前例あり）。
  `server/utils/envCoerce.ts` は **パスを残して common から re-export**:
  `vite.config.ts` → `scripts/lib/devServerPort.ts:23` と `tsconfig.node.json:18` が
  このパスを直接指しており、動かすと dev プロキシの解決経路を巻き込む。
  `DEFAULT_PORT`（バックエンドのポート）は共有ルールではないので server 側に残す。
- **各ブリッジは `asInt` を直接呼ばない**。9 個とも既に `@mulmobridge/webhook-runtime` の
  `createWebhookApp` を使っているので、そこに `listenWebhook` を 1 つ置く。
  D-1/D-2/D-3 が 1 箇所に収まり、各ブリッジは環境変数名を 1 回だけ書く。
- **D-2** `server.on("error")` で `EADDRINUSE` / `EACCES` を環境変数名入りで説明して `exit(1)`。
- **D-3 打ち間違いは `exit(1)`**（ユーザー判断）。`asInt` の契約は変えない —
  不正判定は `asInt(raw, -1, PORT_RANGE) === -1` で行う（`PORT_RANGE.min` が 0 なので
  `-1` は正常値として返り得ない番兵）。
- **D-6** `exit(1)` のみ。supervisor は持ち込まない（#3080 の責務）。
- **email / irc の同型パターンは含めない**（発信先ポートで `PORT_RANGE.min: 0` が意味を持たない。別 issue）。

## 変更

1. `packages/common/src/envCoerce.ts`（新規） — `asInt` / `PORT_RANGE` / `IntRange` を
   `server/utils/envCoerce.ts` から移設（**ロジックは 1 文字も変えない**）。`index.ts` から re-export。
2. `server/utils/envCoerce.ts` — common から re-export し、`DEFAULT_PORT` だけ残す。
3. `packages/webhook-runtime/src/port.ts`（新規、純粋・`process` を触らない）
   - `resolveWebhookPort(raw, fallback, envVar): PortResolution`
   - `describeListenError(err, port, envVar): string`
4. `packages/webhook-runtime/src/index.ts` — `listenWebhook(app, { envVar, fallback }, onReady)`。
   解決失敗 → メッセージ + `exit(1)`（listen しない）。`listen` の `error` → 説明 + `exit(1)`。
   `onReady` には **実際に bind されたポート**を渡す（`PORT=0` のとき既定ログが `0` になるのを防ぐ）。
5. 受信型 9 個: `const PORT = Number(...) || N` を削り、`listenWebhook` 呼び出しに置換。
6. テスト: `packages/webhook-runtime/test/test_port.ts`（純粋関数を両方向）、
   `packages/common/test/test_env_coerce.ts`（移設したルールの pin）。
   listen 側は実サーバで `EADDRINUSE` を踏ませて `onFatal` の seam で観測する。

## 既存挙動の保全（検証すること）

- 正常値・未設定のときの解決結果と**ログ 1 バイトも変えない**。
  → 移設前の `asInt` を throwaway harness にコピーし、生成入力で新旧を比較（`/refactor-safely`）。
- 空白のみ（`PORT="  "`）: 今日は `Number("  ")=0 → falsy →` 既定。`raw.trim() === ""` を
  fallback 扱いにすることで**今日の挙動を維持**する（`asInt` 単体だと 0 = ephemeral になる）。

## publish 順（マージ後、別作業）

`@mulmoclaude/common`（新 export → bump 必須）→ `@mulmobridge/webhook-runtime`（range を
新しい common に sweep）→ 受信型 9 ブリッジ。bottom-up + tag + range sweep は `/publish` に従う。
**本 PR では range を触らない**（宣言は npm の latest = `^1.2.0` のまま）。

## 実装中に見つかったこと（設計に影響した）

**Express 5 は bind が失敗しても `app.listen` のコールバックを呼ぶ。** `express@5.1` で確認:
`address()` は `null`、`listening` は `false`、`error` イベントは次の tick。素直に
`onReady` を呼ぶと、**衝突したブリッジが `Webhook listening on http://localhost:3002/webhook`
を出した直後にエラーを出す** — #3084 が問題にしている「黙って落ちる」が 1 段後ろにずれるだけ。
`listenWebhook` は `server.address()` に port があることを確認してからのみ `onReady` を呼ぶ。

## 検証結果

| 検証                                                                                     | 結果                       |
| ---------------------------------------------------------------------------------------- | -------------------------- |
| `asInt` 移設の等価性（新旧を生成入力で比較）                                             | 620,368 ケース、差分 **0** |
| `packages/common/test/test_env_coerce.ts`                                                | 11 pass                    |
| `packages/webhook-runtime/test/test_port.ts` + 既存                                      | 64 pass                    |
| `test/scripts/test_devServerPort.ts`（dev プロキシが同じルールを引く）                   | 54 pass                    |
| `tsc -p server/tsconfig.json` / `test/tsconfig.json` / `tsconfig.node.json` / 各 package | clean                      |
| eslint（触った全パス）                                                                   | clean                      |

**実機**（`packages/bridges/webhook/dist/index.js` を実際に起動）:

| 条件                    | 結果                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------ |
| 未設定                  | `Listening on http://localhost:3009/webhook`（**従来と同一**）                       |
| `WEBHOOK_PORT=302a`     | exit 1 + 値・範囲・環境変数名を含むメッセージ（従来: 黙って 3009）                   |
| `WEBHOOK_PORT=99999`    | exit 1 + 同メッセージ（従来: そのまま listen してクラッシュ）                        |
| `WEBHOOK_PORT=0`        | `Listening on http://localhost:51167/webhook`（従来: 不可能）                        |
| 3009 を他プロセスが占有 | exit 1 + `Port 3009 is already in use. Set WEBHOOK_PORT to ...`、**banner は出ない** |

サーバ本体の起動（`yarn dev`）は実行していない: 別セッションのテストスイートでこのマシンが飽和
しており（load average ~50）、2 つ目のサーバはユーザーの workspace の `.server-port` /
`.session-token` を奪う。サーバ側の差分は re-export のみで、等価性・dev プロキシのテスト・
実際の import 解決で確認した。
