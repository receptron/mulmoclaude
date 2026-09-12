# fix(bridges): 常駐プロセスとしての堅牢化 — unhandledRejection / SIGINT (#3084 D-4〜D-6)

PR-B。PR-A（受信ポートの読み取りと bind、9 個）とは触るファイルも revert 単位も違うので
issue の D-4 は **(b) 2 本に割る** を採った。PR-A の上に積む（同じ `index.ts` の import 行を
両方が触るため）。

## 現状（測った事実 — `packages/bridges/*` 25 個を数えた）

| 観点                 | 持っているブリッジ | 25 個中    |
| -------------------- | ------------------ | ---------- |
| `unhandledRejection` | なし               | **0 / 25** |
| `uncaughtException`  | なし               | **0 / 25** |
| `SIGINT` / `SIGTERM` | telegram, nostr    | **2 / 25** |

- Node 15 以降、未処理の rejection は**プロセスを落とす**。ハンドラが 1 つも無いので、
  どこか 1 つの `await` が漏れただけで、**どのブリッジが死んだのかも言わないスタックトレース**
  だけが残る。外から見ると「bot が急に返事をしなくなった」。
- 残り 23 個は Ctrl+C で在庫処理の途中でも即死する（受信型なら処理中の webhook、
  ポーリング型なら取得済みで未処理の update が失われる）。

## 決定（D-5, D-6）

- **D-5 家は `@mulmobridge/client`**。**25 個すべてが依存済み**。
  `installProcessGuards({ name, onShutdown? })` を 1 つ置き、各 `index.ts` から 1 行呼ぶ。
  - `unhandledRejection` / `uncaughtException`: ブリッジ名 + 理由を 1 行で出して `exit(1)`。
    **ハンドラを入れると Node 自身の終了が抑制される**ので、明示的に exit する
    （狙いは「読めるメッセージ」で、「エラーを生き延びる」ことではない）。
  - `SIGINT` / `SIGTERM`: 1 行出して `onShutdown` を待ってから `exit(0)`。
    2 回目のシグナルは grace を待たずに即 `exit(1)`（Ctrl+C を 2 回押す人の意図を尊重）。
    `onShutdown` が固まった場合の上限は 5 秒。
- **telegram / nostr は既に正しく書けている唯一の例なので壊さない。**
  telegram の `AbortController` + `client.close()` と nostr の cursor flush を
  そのまま `onShutdown` として渡し、各自の `process.on("SIG…")` を消す
  （telegram は SIGTERM も拾えるようになる）。
- **D-6 `exit(1)` のみ。supervisor は持ち込まない**（#3080 の責務。2 つあると喧嘩する）。
- **`cli` は対象外**: 対話型の readline REPL で常駐プロセスではなく、Ctrl+C は readline の
  持ち物。残り 24 個に入れる。

## 変更

1. `packages/client/src/processGuards.ts`（新規）+ `index.ts` から export。
2. `packages/client/test/test_processGuards.ts`（新規）— `exit` を seam にして
   実際に `process.emit` し、終了コードとメッセージを両方向で確認。
3. 24 個の `index.ts` に 1 行（telegram / nostr は `onShutdown` 付きで、既存ハンドラと置換）。

## 検証（実機）

| 条件                                   | 観測                                                              |
| -------------------------------------- | ----------------------------------------------------------------- |
| 起動中の bridge に `SIGINT`            | `[webhook] SIGINT — shutting down`、exit 0                        |
| 起動中の bridge に `SIGTERM`           | `[webhook] SIGTERM — shutting down`、exit 0（従来: 無言で即死）   |
| 未処理 rejection（guards なし = 従来） | どのブリッジかを言わないスタックのみ                              |
| 未処理 rejection（guards あり）        | `[line] unhandled rejection — exiting: <理由>` + スタック、exit 1 |
