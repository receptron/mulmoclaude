# fix: `.server-port` を対の片割れとして掃除する (#3082)

## 背景

ブリッジは socket.io の handshake (`auth.token`) で bearer token を送りますが、
**接続先が本当に MulmoClaude サーバかは送る前に確認していません**。そのため

- サーバが止まっている
- `<workspace>/.server-port` に残った番号のポートを別のローカルプロセスが掴んでいる

が揃うと、token がその無関係なプロセスに渡ります（#3081 のレビューで Codex が指摘）。

**これは #3081 で入った露出ではありません。** 修正前もポートが `localhost:3001` 固定
だったので、同じ 2 条件で同じことが起きます。変わったのは番号だけです。

## 既にある非対称

`server/index.ts` の `gracefulShutdown()` は **`.session-token` を消しています**:

> Graceful shutdown: best-effort cleanup of the auth token file so other readers
> (Vite plugin, future bridges) don't latch onto a dead token.

`.server-port` は**対の片割れ**で、サーバが起動ごとに一緒に書くのに、**消していません**。
この PR はその非対称を解消するだけで、新しい方針を持ち込みません。

削除して安全である論拠は `scripts/wait-for-backend.ts` の `reset()` に既に書かれています:

> Safe to delete: it only ever addresses a live server, so it is meaningless once
> that server is gone.

## 変更

1. **`deleteServerPort()`** を `server/workspace/serverPort.ts` に追加し、
   `gracefulShutdown()` で `deleteTokenFile()` と並べて呼ぶ。
2. **起動時、`resolvePort()` の後・`generateAndWriteToken()` の前**に同じ削除を行う。
   - **`resolvePort()` より後である理由**: 明示 `PORT` が塞がっていると `resolvePort()` は
     `process.exit(1)` する。先に消すと、**そのポートを掴んでいる生きたインスタンスが
     publish したファイル**を道連れにする。
   - **torn pair の窓を閉じる**のがこれ。サーバは token → port の順で書くので、両方の read が
     その区間に入ると「**新しい token + 古いポート**」になりうる（#3081 で読み取り順を
     入れ替えて窓を狭めたが、閉じてはいない）。起動時に消しておくと、その区間で読めるのは
     「新しい token + ポート無し」だけになり、**前世代のポートと現世代の token が対になる
     ことがなくなる**。
   - **これは「正しい対」を保証しません。** 「ポート無し」はクライアントでは
     `http://localhost:3001` へのフォールバックになります。つまり**危険な対（前世代の
     具体的なポート）が、既定値という従来どおりの挙動に置き換わる**だけです。過剰に
     主張しないこと。
3. 残る脅威を**判断として文書化**する（`docs/bridge-protocol.md`）。

## 残る脅威（意図的に対処しない）

token を送る前に相手を検証はしません。理由:

- **単一ユーザ機では露出が等価**。`.session-token` は mode 0600 で、同じユーザで動く
  プロセスは**そのまま読めます**。ポートを掴んで待つ必要がありません。
- 差が出るのは**別のローカルユーザが loopback ポートを掴む多人数マシン**だけ
  （loopback の bind はユーザ単位ではない）。
- 対処には認証不要の identity エンドポイント新設か challenge-response が要り、
  25 ブリッジ共通のプロトコル変更になります。上の 2 点に対して釣り合いません。

判断として `docs/bridge-protocol.md` に残し、覆すときに読めるようにする。

## 検証

- 単体: `deleteServerPort()` が「ファイルあり / 無し / 親ディレクトリ無し」で例外を投げない。
- **起動→停止の実挙動**: 実際にサーバを起動し、`.server-port` と `.session-token` が
  両方できることを確認 → SIGTERM → **両方消えている**ことを確認。これが外部 ground truth。
- **順序**: 明示 `PORT` が塞がっている状態で起動し、`resolvePort()` が exit する経路で
  **既存の `.server-port` が残る**ことを確認（生きたインスタンスを道連れにしない）。
- 既存読み手がポート不在に耐えることの再確認: hooks の `buildAuthPost` は null で
  silent no-op、`proxyTargetFollower` は「読めない値では proxy を動かさない」仕様。
