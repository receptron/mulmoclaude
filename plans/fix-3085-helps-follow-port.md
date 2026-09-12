# fix: 同梱ヘルプを「3001 固定」から実装に合わせる (#3085)

## 背景

#3081 / #3092 でブリッジはサーバの実 bind ポートに追従し、再起動にも自力で追従する
ようになりました。ところが **`@mulmoclaude/core` が同梱する help text は 3001 固定のまま**です。

これは単なる古い記述ではありません。**エージェントはツール失敗時にユーザーへ聞き返す
前にこのファイルを読みます**（`server/prompts/system/system.md` の「When a tool call
fails」）。つまり古い記述は、エージェントが**古い助言をする**ことを意味します。

## 変更

### 1. `telegram.md` — 3 箇所

| 行 | 現状 | 問題 |
|---|---|---|
| L10 | 「`localhost:3001` 経由で MulmoClaude に転送する」 | ポートは固定ではない |
| L44 | 「`[server] listening port=3001` が出るまで待つ」 | **待つ対象が間違っている**。`PORT` 指定や前進で別の番号になる |
| L132 | 「ブリッジは `localhost:3001` としか話さない」 | **セキュリティ上の主張自体は今も真**（loopback にしか繋がない）。番号だけが誤り |

### 2. `custom-view.md` — 1 箇所

`window.__MC_VIEW.dataUrl` の例が `http://localhost:3001/...`。これは**ホストが注入する
値の例示**で、ビューが自分で組み立てるものではありません。性質が違うので「ホストが埋める」
ことが読める形にするだけに留めます。

### 3. `error-recovery.md` — 新規セクション（この issue の本命）

**メッセージングブリッジの節が 1 つも無い**ので、「bot が返事をしない」という最頻の症状に
対してエージェントは何も持っていません。追加する内容:

- **ブリッジ自身が接続先を表示する**ことを最初に使う（`Connecting to http://127.0.0.1:<port>`）。
  **ただし書いた時点では CLI の 1 本しか出していませんでした**（25 本中 1 本）。ヘルプが
  当てにする診断は実在していなければならないので、**共有クライアント側に移して 25 本全部が
  出す**ようにしました（CLI の重複行は削除）。
  `cat <workspace>/.server-port` と突き合わせれば、古い npm ビルドかどうかが**バージョンを
  知らなくても**判別できる。バージョン番号で書かないのは、それが陳腐化するため。
- 「`The server has not published a port yet`」は**待機中**であって故障ではない
  （cold start では sandbox の Docker ビルドで数分かかりうる）。放っておけば合流する。
- 別マシン / workspace を mount していないコンテナでは sidecar を読めないので
  `MULMOCLAUDE_API_URL` と `MULMOCLAUDE_AUTH_TOKEN` の両方が要る。
- **「サーバを再起動したらブリッジも再起動してください」と言わないこと。** #3078 以降、
  ブリッジは接続失敗のたびに対を読み直して socket を作り直す。

## リリース

`assets/helps/*` は `files: ["dist", "assets"]` で npm に載るので、**`@mulmoclaude/core` の
版上げが要る**（CLAUDE.md）。4.8.0 → 4.9.0。`check:launcher-sync` は「宣言レンジの下限 =
workspace の version」を要求するので、**宣言レンジを同じ PR で sweep** する（**9 マニフェスト / 17 フィールド** — `dependencies` / `peerDependencies` / `devDependencies` に分かれて入っているので、マニフェスト数とフィールド数は一致しない）。

publish はこの PR では行わない。

## 検証

- 全 helps を `3001` で grep して、残るのが「例示」だけであることを確認する。
- `telegram.md` の L44 は**サーバが実際に出すログ行**（`log.info("server", "listening",
  { port })` → `[server] listening port=<N>`）と突き合わせる。
- `drift.mjs` / `launcherSync.mjs` / `check:changelog-ships` / `check:doc-links`。
