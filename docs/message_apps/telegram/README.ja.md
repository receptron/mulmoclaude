# MulmoClaude — Telegram ブリッジ

自分の PC で動かしている MulmoClaude と Telegram アプリから会話
できるようにします。このドキュメントは **運用者** 向け — MulmoClaude
をホストしていて、bot を家族・友人と共有したい人を想定。

English: [`README.md`](README.md)

---

## 完成した状態

- 自作の Telegram bot (名前も画像も自由) が、自分の PC 上で
  動く MulmoClaude にメッセージを中継する。
- その bot に話しかけられる Telegram アカウントの **許可リスト**
  (allowlist) を管理する。リスト外の人には `"Access denied"` が
  返る。
- ターミナル A で `yarn dev`、ターミナル B で `yarn telegram` を
  同時に動かしている状態。

PC を閉じたりネットを切ったりすると bot は沈黙します。

> **ヒント**: オフライン時のメッセージキューが欲しいですか？
> [MulmoBridge Relay](../relay/README.ja.md) を使えば、メッセージが
> クラウドに保存され、PC がオンラインに戻ったときに届きます。
> セットアップ: Claude Code で `/setup-relay` を実行。

---

## ステップ 1 — BotFather で bot を作る

1. Telegram (スマホ or デスクトップ) を開く。
2. `@BotFather` を検索 (公式には青いチェックマーク)。チャットを
   開始する。
3. `/newbot` を送信。
4. 2 つ聞かれるので答える:
   - **表示名 (Display name)**: チャット上部に出る名前。何でも可。
     例: `"アリスの MulmoClaude"`
   - **ユーザー名 (Username)**: 末尾が `bot` で終わる、Telegram
     全体でユニークな文字列。例: `alice_mulmoclaude_bot`
5. BotFather が **token** を返す — `1234567890:AAHdqTcv…` のような
   長い文字列。**この token は bot のパスワードです。外に漏らさない。**
   token を持っている人は誰でも bot になりすませます。

後から設定できる便利項目 (任意):

- `/setdescription` — チャット開いた時の説明文
- `/setuserpic` — アイコン画像
- `/setprivacy` → `Disable` — グループチャットでも全メッセージを
  見たい場合 (デフォルトはグループでは `/` 始まりのコマンドしか
  見えない)

---

## ステップ 2 — MulmoClaude とブリッジを起動

ターミナル A で MulmoClaude サーバを起動:

```bash
yarn dev
```

`[server] listening port=…` が出るまで待つ。番号はサーバが実際に bind した
ポートです — `PORT` を尊重し、既定値が塞がっていれば先へ進みます。控えて
おく必要はありません。ブリッジが workspace から読みます。

ターミナル B で Telegram ブリッジを起動する。allowlist は **最初は
わざと空** にしておく (次ステップで自分の chat ID を取得するため):

```bash
export TELEGRAM_BOT_TOKEN='1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
export TELEGRAM_ALLOWED_CHAT_IDS=''
yarn telegram
```

こう表示されれば OK:

```
MulmoClaude Telegram bridge
Allowlist: (empty — all chats will be denied)
Connecting to http://127.0.0.1:<port>
Connected (<socket id>).
```

---

## ステップ 3 — 自分の chat ID を取得して allowlist に入れる

1. Telegram で自分の bot (Step 1 で付けたユーザー名で検索) を
   開き、適当に `hi` などメッセージを送る。
2. ターミナル B の `yarn telegram` のログに:
   ```
   [telegram] denied chat=987654321 user=@alice — not on allowlist
   ```
   のような行が出る。`987654321` が **あなたの Telegram chat ID**。
3. ブリッジを `Ctrl+C` で止めて、allowlist にその ID を入れて
   再起動:

   ```bash
   export TELEGRAM_ALLOWED_CHAT_IDS='987654321'
   yarn telegram
   ```

4. もう一度 bot にメッセージを送る → 今度は MulmoClaude からの
   返信が返ってくる。

---

## ステップ 4 — 友人を招待

友人にこの bot を使わせたい場合:

1. 友人に bot のユーザー名を教える。友人が bot を検索してメッセージ
   を送る。
2. `yarn telegram` のターミナルに友人の chat ID が `denied` ログで
   表示される。
3. その ID を allowlist に追加して再起動:

   ```bash
   export TELEGRAM_ALLOWED_CHAT_IDS='987654321,123456789'
   yarn telegram
   ```

4. 友人がもう一度 bot に話しかけると通るようになる。

環境変数は `.env` やシェルの rc ファイルに書いておくと毎回 export
しなくて済みます。

---

## bot が理解するコマンド

CLI と同じです。Telegram チャットにそのまま入力してください:

- `/help` — ヘルプ表示
- `/reset` — 新しい会話セッションを開始
- `/roles` — 利用可能なロール一覧
- `/role <id>` — ロール切替
- `/status` — 現在のセッション情報

それ以外のテキストはアシスタントへのメッセージとして扱われます。

---

## トラブルシューティング

**ブリッジに `Connect error: bearer token rejected` が出る。**
MulmoClaude サーバを再起動すると bearer token が変わります。
**何もしなくて構いません** — ブリッジは接続に失敗すると token と
ポートを読み直し、たいてい 1〜2 秒で自力で再接続します (#3078)。
それでも出続けるなら、サーバがまだ起動し終えていません: token を
書いてからポートを bind するまでの間に sandbox のビルドが入ります。
`MULMOCLAUDE_AUTH_TOKEN` の固定は、workspace をそもそも読めない
ブリッジ（別マシン、mount していないコンテナ）のためのものです
([`../../developer.md`](../../developer.md) の Auth セクション参照)。

**`TELEGRAM_ALLOWED_CHAT_IDS: "foo" is not an integer chat id` と出る。**
allowlist に書き間違いがあります。chat ID は整数のみ — 空白・
引用符・`#` プレフィックスは入れられません。

**友人の ID を追加したのに `"Access denied"` と返る。**
env を変えた後にブリッジを再起動しましたか？ allowlist は起動時に
一度だけ読まれます。

**エラーも出ないのに返事が返ってこない。**
`yarn dev` が生きているか確認。サーバを閉じてもブリッジは起動
したままですが、話しかける相手がいません。次のメッセージで
`Connect error` か `Disconnected` が出るはずです。

**1 ユーザーしか入れていないのに、グループチャットで bot が
反応する。**
グループの chat ID は **負の数** (Telegram の仕様)。特定のグループ
を許可したい場合はその負の ID を allowlist に入れてください。
デフォルトでは BotFather が作る bot は「グループプライバシーモード」
が有効で、グループでは `/` 始まりのコマンドしか見えません。全
メッセージを見せたい場合は BotFather の `/setprivacy` で切り替え
てください。

---

## セキュリティに関する注意

- bot token はパスワードと同じ扱い。漏れたら BotFather で
  `/revoke` を実行して再生成してください。
- allowlist だけが「友人」と「地球上の全 Telegram ユーザー」を
  隔てる唯一の防御です。友人でなくなった人の chat ID は外して
  ブリッジを再起動してください。
- ブリッジは chat ID・ユーザー名・メッセージ長をログに残しますが、
  **メッセージ本文や bot token は残しません**。完全な監査ログが
  必要なら、別途 Telegram 側で何か記録する必要があります。
- MulmoClaude の bearer token は外に出ません。Telegram bridge は
  IPv4 loopback にしか繋がらず、あなたの友人は Telegram の
  サーバとだけ通信します。
