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

`token.ts` は `workspace.ts` 経由に付け替え。`TOKEN_FILE_PATH` の export 形
（module load 時に確定する定数）は既存テスト / エラーメッセージのため維持。

## 検証

- 単体: `parsePublishedPort` の表（正常 / 改行付き / 空 / 空白のみ / 非数字 /
  `3002abc` / `0` / `65536` / 負）、`resolveApiUrl` の優先順位 4 通り、
  `MULMOCLAUDE_WORKSPACE_PATH` を立てた場合の token / port 読み。
- 実機: `PORT` を塞いでサーバを前進させ、CLI ブリッジ（`yarn cli`）が
  publish されたポートに繋がることを確認する。`.server-port` が無い場合に
  3001 へ落ちることも確認する。

## 対象外（PR に明記する）

- Docker 内で動くブリッジ（`MULMOCLAUDE_HOST`）。hooks 用の規約で、ブリッジは
  ホスト側で動く前提。今回は触らない。
- 起動後の追従。ポートは `createBridgeClient()` 時に 1 回だけ読む。実行時追従は
  A-3（socket 作り直し）と同じ話なので #3078 に残す。
