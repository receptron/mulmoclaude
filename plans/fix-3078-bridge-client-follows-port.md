# fix: ブリッジの共有クライアントを `.server-port` に追従させる (#3078)

## 背景

`packages/client/src/client.ts` の `apiUrl` は `opts.apiUrl → MULMOCLAUDE_API_URL →
http://localhost:3001` で解決していた。サーバは 3001 に固定されていない
（`server/index.ts` の `resolvePort()` が塞がっていれば前進し、`PORT` でも動く）ので、
25 個すべてのブリッジが「いないところ」または「別インスタンス」に繋ぎにいく。

`<workspace>/.server-port` は「このプロセスの外がサーバの居場所を知る唯一の手段」
（`server/workspace/serverPort.ts`）で、#2650 / #2981 では Vite proxy と
`wait-for-backend` がこれを読むことで解決済み。ブリッジだけ取り残されていた。

同じパッケージの `token.ts` は `.session-token`（`.server-port` と対の sidecar）を
既に読んでいるが、**workspace root を `~/mulmoclaude` 固定**で持っており
`MULMOCLAUDE_WORKSPACE_PATH` を見ていない。port を読むには同じ root が要るので、
root の解決も同時に直す。

## スコープ（ユーザー判断済み）

- **A-1 ポート追従** — `apiUrl` の解決順に `<workspace>/.server-port` を挟む。
- **A-2 workspace の尊重** — sidecar の root を `MULMOCLAUDE_WORKSPACE_PATH` 経由にする。
- **A-3（token 読み直し + 再接続）はこの PR では扱わない。** サーバ再起動後は
  ポートも変わりうるので socket 自体の作り直しが要り、性質の違う変更になる。
  #3078 はこの PR では閉じない。

実装場所は `@mulmoclaude/common` に上げず **`packages/client` 内**（ユーザー判断）。
common は意図的に node builtin ゼロの isomorphic パッケージで、server 側
`hooks/shared/sidecar.ts` は root を `CLAUDE_PROJECT_DIR` から取る別物のため。

## 設計

新規 `packages/client/src/workspace.ts`:

- `workspaceRoot()` — `MULMOCLAUDE_WORKSPACE_PATH` → `<homedir>/mulmoclaude`。
  server の `server/workspace/paths.ts:workspacePath` と同じ規則（test 環境の
  tmpdir 分岐はサーバ内部の都合なので持ち込まない）。
- `SIDECAR_FILES = { token: ".session-token", port: ".server-port" }` — 対で 1 箇所。
- `readSidecarFile(name)` — trim して空なら `null`、読めなければ `null`。

新規 `packages/client/src/apiUrl.ts`:

- `parsePublishedPort(raw)` — trim 後 **10 進数字のみ**を受け付け、1..65535 に収める。
  書き手は `formatServerPort()`（`${port}\n` 固定）なので厳格で良い。`parseInt` の
  ような緩い解釈だと `3002abc` が 3002 として通る。
- `readPublishedApiUrl()` — 公表ポートがあれば `http://127.0.0.1:<port>`。
  `localhost` ではなく `127.0.0.1`：サーバは `app.listen(port, "127.0.0.1")` で
  IPv4 loopback に明示 bind するが、dual-stack では `localhost` が先に `::1` を
  引く。そこに別プロセスがいると黙って別サーバに繋がる（#2981 で実測済み）。
- `resolveApiUrl(explicit)` — `explicit → MULMOCLAUDE_API_URL → 公表ポート → 既定`。
  明示指定が最優先なのは従来どおりなので既存の使い方は壊れない。
  空文字は「未設定」として次に落とす（`readBridgeToken` の
  `MULMOCLAUDE_AUTH_TOKEN` の扱いに合わせる。従来の `??` は `""` をそのまま
  `io("")` に渡していた）。

`token.ts` は `workspace.ts` 経由に付け替え。`TOKEN_FILE_PATH` は #272 以来の公開 API
なので残すが、**module load 時に確定するスナップショット**なので、I/O と表示は新設の
`tokenFilePath()`（呼び出し時解決）を通す。両者が食い違う境界＝「import 後に workspace を
設定した場合」もテストで固定する。

`createBridgeClient()` は **token を先に、port を後に**読む。サーバが
`.session-token` → `.server-port` の順で書く（`server/index.ts:1386` → `:1464`）ため、
読み取り順で**どちらのずれが起きやすいか**が決まる。port 先読みは「新しい token を、
サーバが去った直後の古いポートへ」という静かな失敗を招きやすく、token 先読みなら多くの場合
「古い token + 新しいポート」＝正しいサーバが `invalid token` を返す声の出る失敗になる。
**閉じはしない**（両方の read が書き込み区間に入ると危険な対が残る）。

## 検証（実施済み）

- **単体** (`packages/client/test/`, 84 pass): `parsePublishedPort` の受理 6 / 棄却 15
  （`3002abc` や `80@attacker.example` のような `parseInt` なら通る形、オーバーフロー、
  先頭ゼロ、全角数字を含む）、`resolveApiUrl` の優先順位 4 通り + 空値 2 通り、
  `MULMOCLAUDE_WORKSPACE_PATH` 下の token 読み、`TOKEN_FILE_PATH`（import 時）と
  `tokenFilePath()`（呼び出し時）が食い違う境界。
- **CI で走る e2e** (`test/bridges/test_clientFollowsPublishedPort.ts`, 5 pass):
  実 socket.io サーバ 2 本（**どちらも port 0**）がそれぞれ自分の名前を echo し、
  `createBridgeClient()` がどちらに届いたかを ack が言う。単体テストは**規則**を固定できるが
  **結果**は見られない — この修正が防ぐ失敗は「**間違ったサーバに綺麗に繋がる**」なので、
  規則テストはどちらに転んでも同じ緑になるため。
  **break-verify 済み**: build 済み `resolveApiUrl` を「常に既定値」に書き換えると 5 件中 3 件が赤。
  3001 に**置かない**のは意図的（開発者自身の `yarn dev` と奪い合うため）。「さもなくば 3001」は
  socket を使わず `resolveApiUrl()` のケースと単体テストで固定している。
- **実機**: `PORT` を塞いだ状況を mock server 2 本（3001 に「必ずエラーを返す囮」、3099 に本物）で
  再現し、**修正前は `connected: true` のまま囮の ack を受け取り**、修正後は 3099 に到達することを
  確認。`.server-port` 無しで `http://localhost:3001` に落ちることも確認。
- **公開物**: `drift.mjs` / `launcherSync.mjs` / `npm pack --dry-run` で、1.1.0 への bump、
  28 箇所のレンジ sweep、tarball に `dist/apiUrl.*` と `dist/workspace.*` が入ることを確認。

## 対象外（PR に明記する）

- Docker 内で動くブリッジ（`MULMOCLAUDE_HOST`）。hooks 用の規約で、ブリッジは
  ホスト側で動く前提。今回は触らない。
- 起動後の追従。ポートは `createBridgeClient()` 時に 1 回だけ読む。実行時追従は
  A-3（socket 作り直し）と同じ話なので #3078 に残す。

## レビューで判明し、別 issue に切り出した残余

- **#3082** — ① サーバ不在時、残った `.server-port` のポートを別プロセスが掴んでいると
  bearer token がそこへ渡る（**この PR で入った露出ではない**: 修正前も `localhost:3001`
  固定で同じことが起きる）。② sidecar の対に世代マーカーが無く、再起動を跨ぐと torn pair を
  読みうる（読み取り順の入れ替えは窓を狭めるだけ）。対処案として「shutdown で `.server-port`
  を消す」「token を出す前に相手を確認する」「両 sidecar に共通の起動 id を持たせる」を記載。
- **#3085** — `packages/core/assets/helps/*`（telegram.md / custom-view.md）がまだ
  `localhost:3001` と書いている。`assets/helps/*` を触ると `@mulmoclaude/core` の版上げ＋
  18 箇所のレンジ sweep を伴うため、`error-recovery.md` への追記（publish 後に「◯◯ 以降に
  上げてください」と書けるようになってから）とまとめて 1 回の core リリースで行う。
