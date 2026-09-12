# MulmoClaude — LINE ブリッジ

自分の PC で動かしている MulmoClaude と LINE アプリから会話
できるようにします。このドキュメントは **運用者** 向け — MulmoClaude
をホストしていて、bot を家族・友人と共有したい人を想定。

English: [`README.md`](README.md)

> **Experimental** — テストして [問題を報告](https://github.com/receptron/mulmoclaude/issues/new) してください。

---

## 完成した状態

- 自作の LINE 公式アカウント (bot) が、自分の PC 上で動く
  MulmoClaude にメッセージを中継する。
- ngrok でローカル PC のポートをインターネットに公開し、LINE
  の Webhook を受け取れる状態。
- ターミナル A で `yarn dev`、ターミナル B で ngrok、ターミナル C
  で LINE ブリッジを同時に動かしている状態。

PC を閉じたりネットを切ったりすると bot は沈黙します。

> **ヒント**: ngrok の設定が面倒ですか？代わりに
> [MulmoBridge Relay](../relay/README.ja.md) を使えば、固定 URL で
> オフライン時のメッセージキューも可能です。ngrok 不要。
> セットアップ: Claude Code で `/setup-relay` を実行。

### Telegram との違い

Telegram はポーリング方式（bot 側からサーバに聞きに行く）なので
外部からのアクセスを受けず、ngrok も不要です。LINE は Webhook
方式（LINE サーバからあなたの PC に HTTP リクエストが来る）なので
ngrok が必要です。セキュリティ面では Telegram の方がシンプルです。

---

## ステップ 1 — ngrok のセットアップ

ngrok はローカル PC のポートをインターネットに公開するトンネリング
ツールです。LINE の Webhook を受け取るために必要です。

### インストール

```bash
brew install ngrok
```

### アカウント登録と authtoken 設定

1. [ngrok.com](https://ngrok.com) にサインアップ（GitHub アカウントで可）
2. ダッシュボードに表示される authtoken をコピー
3. ターミナルで設定:

```bash
ngrok config add-authtoken <あなたのトークン>
```

### 起動

```bash
ngrok http 3002
```

表示される `https://xxxx.ngrok-free.app` の URL をメモしてください。
ステップ 3 で使います。

---

## ステップ 2 — LINE Messaging API チャンネルを作る

1. [LINE Developers Console](https://developers.line.biz/console/) を開く
2. **プロバイダ** を作成（未作成の場合）
3. **Messaging API** チャンネルを作成
4. **Basic settings** タブの **Channel secret** をメモ
5. **Messaging API** タブで **Channel access token** を発行（long-lived）してメモ

---

## ステップ 3 — Webhook を設定する

LINE Developers Console → **Messaging API** タブで:

- **Webhook URL**: `https://xxxx.ngrok-free.app/webhook`
  - **末尾の `/webhook` を忘れないこと。** 付け忘れると POST が `/` に行き 404 になる
- **Use webhook**: 有効にする

### 応答メッセージを OFF にする

LINE 公式アカウントのデフォルト応答（あいさつメッセージ等）が有効
だと、MulmoClaude の返信と二重に送られてしまいます。

LINE 公式アカウント設定画面 → **応答メッセージ** → OFF にする。

---

## ステップ 4 — 環境変数を設定する

プロジェクトルートの `.env` に以下を追加:

```dotenv
LINE_CHANNEL_SECRET=xxxxxx
LINE_CHANNEL_ACCESS_TOKEN=xxxxxx
```

全環境変数の一覧は [packages/bridges/line/README.md](../../../packages/bridges/line/README.md) を参照。

---

## ステップ 5 — MulmoClaude とブリッジを起動

ターミナル A で MulmoClaude サーバを起動:

```bash
yarn dev
```

`[server] listening port=…` が出るまで待つ。番号はサーバが実際に bind した
ポートです — `PORT` を尊重し、既定値が塞がっていれば先へ進みます。控えて
おく必要はありません。ブリッジが workspace から読みます。

ターミナル B で ngrok を起動（まだ起動していなければ）:

```bash
ngrok http 3002
```

ターミナル C で LINE ブリッジを起動（`yarn dev` が `predev` スクリプト経由で
`packages/bridges/line/dist/` を自動ビルドするので、手動ビルドは不要）:

```bash
node packages/bridges/line/dist/index.js
```

> **注意**: `npx @mulmobridge/line` はモノレポ内では動きません（yarn
> workspaces が bin のシンボリックリンクを作らないため）。`node` で
> 直接実行してください。

---

## ステップ 6 — bot を友だち追加して話しかける

LINE Developers Console → **Messaging API** タブの QR コードを
スキャンして bot を友だち追加。メッセージを送ると MulmoClaude から
返信が来ます。

---

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| ngrok に `POST / 404 Not Found` | Webhook URL に `/webhook` が付いていない | LINE Console で URL 末尾に `/webhook` を追加 |
| bot が二重に返信する | LINE の応答メッセージが ON | LINE 公式アカウント設定 → 応答メッセージ → OFF |
| `LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN are required` | 環境変数が読めていない | `.env` に設定するか、環境変数として export |
| `sh: mulmobridge-line: command not found` | `npx` がモノレポ内で bin を見つけられない | `node packages/bridges/line/dist/index.js` を使う |
| ブリッジに `Connect error: bearer token rejected` | MulmoClaude サーバを再起動して token が変わった | 何もしなくてよい — ブリッジが読み直して自力で再接続します (#3078)。出続けるならサーバがまだ起動中 |
| 返信が来ない（エラーなし） | `yarn dev` が止まっている | MulmoClaude サーバの状態を確認 |

---

## セキュリティに関する注意

- **ngrok は使うときだけ起動**し、終わったら止めること。起動中は
  ポート 3002 がインターネットに公開されている。
- LINE の Channel secret による署名検証があるので、不正なリクエスト
  は弾かれる。ただし ngrok の URL 自体は誰でもアクセスできる。
- Channel secret と Channel access token はパスワードと同じ扱い。
  漏れたら LINE Developers Console で再発行してください。
- MulmoClaude の bearer token は外に出ません。LINE bridge は
  IPv4 loopback にしか繋がりません。
