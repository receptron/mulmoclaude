# feat: ブリッジがサーバの再起動に自力で追従する (#3078 A-3)

## 背景

#3081 で `.server-port` 追従は入りましたが、**読むのは `createBridgeClient()` の 1 回だけ**でした。
サーバが再起動すると:

- token が変わる → 現行コードは `invalid token` を検出して
  **「ブリッジを再起動してください」と表示して終わる**
- ポートも変わりうる → socket の URL は生成時固定なので、そもそも届かない

#3078 の「ユーザーが『サーバを立て直すたびに手でブリッジも立て直し』になる直接の原因」がこれです。

## スコープ（ユーザー判断済み）

**sidecar を読み直して socket を作り直す。** token だけ差し替える案は採らない —
再起動ではポートも変わりうるので、それでは症状の半分しか直りません。
バックオフ付きで無期限リトライ（回数上限は設けない）。

## 設計

**`invalid token` だけでは足りません。** ポートが変わった場合、クライアントは新しいサーバに
**届かない**ので `invalid token` は返ってきません。来るのは `ECONNREFUSED` です。
よって **`connect_error` 全般**で再解決します。

新規 `packages/client/src/supervisor.ts` — 判断部分を純粋に切り出す:

- `credentialsChanged(current, fresh)` — 対が変わったか。変わっていなければ何もしない
  （socket.io 自身のリトライに任せる。無駄に socket を作り直さない）。
- `backoffMs(attempt)` — 上限付き指数バックオフ。時刻も fs も注入しないで済むよう純関数。
- `createSupervisor({ resolve, create, onSwitch, schedule })` — `connect_error` を受けたら
  バックオフ後に `resolve()` し、対が変われば古い socket を破棄して新しく作る。

`client.ts` 側:

- 登録済みハンドラ（push / textChunk / connect / disconnect）を保持し、**作り直した socket に
  再登録**する。`.socket` は現在の socket を返す getter にする
  （リポジトリ内に `.socket` を使う呼び出し元は 0 件なのを確認済み）。
- `send()` は常に**現在の** socket を使う。

**再起動中は token が一時的に存在しません。** サーバは shutdown で `.session-token` を消し、
起動時に書き直します（#3082 で `.server-port` も同様に）。よって `resolve()` は
「まだ無い」を返せる必要があり、そのときは**プロセスを落とさずに**待ち続けます。
起動時の `requireBearerToken()`（無ければ exit）とは別の経路です。

## 検証

- 単体: `credentialsChanged` の表、`backoffMs` の単調性と上限。
- **e2e（実 socket.io サーバ）**: #3081 の `test/bridges/` と同じ形で、
  ① token だけ変えたサーバ再起動にブリッジが自力で追従する
  ② **ポートが変わる**再起動に追従する（A-3 の本体）
  ③ 再起動中の token 不在を跨いでも死なない
  ④ **入れ替えた socket が止まること**（`connected` も `active` も false。再起動ごとに
     死んだポートを叩き続ける manager が積み上がると leak になる）
  ⑤ 対が変わっていなければ socket を作り直さない（negative control）
- break-verify: 追従ロジックを無効化すると **5 件中 4 件が赤**になり、⑤ だけ緑のまま。

## 対象外

- 起動後のポーリングによる先回り追従。エラー駆動のみ（余計な fs 読みを増やさない）。
- Docker 内ブリッジ（`MULMOCLAUDE_HOST`）。#3081 と同じく対象外。
