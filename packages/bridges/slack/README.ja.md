# @mulmobridge/slack

> **試験運用中** — ぜひ使ってみて [Issue で報告](https://github.com/receptron/mulmoclaude/issues/new) してください。フィードバックが開発の助けになります。

[MulmoClaude](https://github.com/receptron/mulmoclaude) 向けの Slack ブリッジ。**Socket Mode** を使うので、公開 URL や ngrok は不要です。

English: [`README.md`](README.md)

## セットアップ

### 1. Slack アプリを作成

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. 名前（例: `"MulmoClaude"`）と利用するワークスペースを選択

### 2. 権限を設定

**OAuth & Permissions** → 以下の Bot Token Scope を追加:
- `chat:write` — メッセージ送信
- `channels:history` — 公開チャネルのメッセージ閲覧
- `groups:history` — プライベートチャネルのメッセージ閲覧
- `im:history` — DM の閲覧
- `mpim:history` — グループ DM の閲覧
- `reactions:write` — **任意**。`SLACK_ACK_REACTION` を有効にするときだけ必要 (下記参照)

### 3. Socket Mode を有効化

**Socket Mode** → **Enable Socket Mode** をオンにして、`connections:write` スコープで App-Level Token を作成。`xapp-...` トークンをコピー。

### 4. Event を有効化

**Event Subscriptions** → **Enable Events** をオンにして、以下にサブスクライブ:
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

### 5. ワークスペースにインストール

**Install App** → **Install to Workspace** → `xoxb-...` Bot User OAuth Token をコピー。

### 6. ブリッジを起動

```bash
# モックサーバー（テスト用）
npx @mulmobridge/mock-server &
SLACK_BOT_TOKEN=xoxb-... \
SLACK_APP_TOKEN=xapp-... \
MULMOCLAUDE_AUTH_TOKEN=mock-test-token \
npx @mulmobridge/slack

# 実 MulmoClaude と連携
SLACK_BOT_TOKEN=xoxb-... \
SLACK_APP_TOKEN=xapp-... \
npx @mulmobridge/slack
```

### 7. bot をチャネルに招待

Slack で `/invite @MulmoClaude` を実行して bot をチャネルに招待。

---

## セッション粒度（新機能）

> **「セッション」とは?** MulmoClaude では、1つの *セッション* = AI との 1 本の会話履歴です。AI はそのセッション内で過去の発言を覚えていて、それを踏まえて返事します。以下の設定は **1 つの Slack チャネルが何個のセッションに分割されるか** を決めます。

`SLACK_SESSION_GRANULARITY` 環境変数で 3 モードから選べます:

### 🗂 `channel`（デフォルト）— チャネルあたり 1 セッション

`#ai-help` の中のすべての発言が **1 本の長い会話** になります。誰が話しても、スレッドを使っていても、全部同じ会話扱いです。

```text
#ai-help
├── Alice: 「昨日のスタンドアップまとめて」            ┐
├── Alice: 「それ日本語に訳して」                      │  ← 1セッション。
├── Bob:   「アクションアイテムはどう?」                │    AI が上の
│   ├── Alice: 「私に割り振られたやつだけ」             │    発言全部を
│   └── Bob:   「了解」                                │    覚えている
└── Alice: 「それをもとにステータス共有を下書きして」   ┘
```

**こういう人におすすめ:** 小規模チーム、または `@claude` との個人 DM。すべての発言が一続きの会話になっている場合。

**注意点:** 何週間も使い続けるとセッションに大量のコンテキストが溜まり、AI が古い情報まで引っぱり始めて応答が遅く（&高く）なります。リセットしたいときは **別チャネルを作る** のが確実です。

### 🧵 `thread` — Slack スレッドあたり 1 セッション（自動スレッド化）

チャネル直下のトップレベル発言も、**bot の最初の返信で自動的にスレッド化** されます。スレッド内の発言はすべて独立した 1 セッション。違う話題をいくつも投げると、それぞれが自分のスレッドになるので、返信がチャネル直下でごちゃ混ぜになりません。

```text
#ai-help
├── Alice: 「昨日のスタンドアップまとめて」  ─────────┐
│   └── 🤖: 「まとめました…」                           ├  ← スレッドセッション #1
│       Alice: 「日本語に訳して」                       │    (bot 返信時に
│       🤖: 「…」                                        │     自動生成)
│
├── Bob:   「アクションアイテムはどう?」    ────────── ┐
│   └── 🤖: 「アクションアイテムは…」                    ├  ← スレッドセッション #2
│       Bob: 「デプロイ担当は誰?」                       │    (別話題 = 別スレッド)
│       🤖: 「…」                                        │
│
└── Alice: 「ステータス共有下書いて」       ────────── ┐
    └── 🤖: 「下書きを作成しました…」                    ├  ← スレッドセッション #3
        Dev: 「デプロイノートも入れて」                  │    (誰でも続きを書ける)
        🤖: 「…」                                        │
```

**こういう人におすすめ:** 複数人が別々の質問を投げる `#ai-help` や `#general` のような共有チャネル。スレッドで話題を分離するので「Alice の翻訳タスク」と「Bob のデプロイ質問」が混ざらない。

**注意点:**

- v0.2 以降の挙動変更: このモードでは bot の返信が **常に** スレッド内になります。以前はトップレベル発言への返信もトップレベルでした。旧挙動を維持したい場合は `channel` または `auto` を使ってください。
- 各スレッドが別セッション扱いなので、AI は同じチャネル内の別スレッドの文脈を自動では知りません。「昨日の投稿と同じスタイルで」と頼んでも、その投稿を引用したり、そのスレッドで質問したりしないと bot には見えません。
- DM は対象外 — 1:1 会話でスレッドを切る意味はないため、DM は常にトップレベルのままです。

### 🤖 `auto` — オプトインスレッド化（将来の自動判定用予約）

トップレベル発言は `channel` と同じく 1 セッション共有、ユーザーが手動でスレッドを切った場合はスレッドごとのセッションになります。将来、もっと賢い判定（例:「チャネル名の命名規則から推論」）を導入する予定の予約スロットです。

### 早見表

| モード | チャネル直下の発言 | スレッド内返信 | 向いているケース |
|---|---|---|---|
| `channel`（デフォルト） | → チャネルセッション（トップレベル返信） | → **チャネルセッション**（同じ会話、スレッド内返信） | 1:1 DM、小規模チーム |
| `thread` | → **自動でスレッド生成**（話題ごとに新セッション） | → スレッドセッション（新しい会話） | 話題が並走する共有チャネル、マルチトピック運用 |
| `auto` | → チャネルセッション（トップレベル返信） | → スレッドセッション（新しい会話） | 将来に備える、オプトインスレッド |

### どれを選ぶか

| こういう使い方をしたい | 設定値 |
|---|---|
| 「シンプルに。1チャネル = 1会話。」 | `channel`（または未設定） |
| 「自分の質問と他の人の質問が混ざってほしくない。」 | `thread` |
| 「先のことは開発者に任せる。妥当なデフォルトを使う。」 | `auto` |

### モード切替は安全?

粒度を変えても **既存のセッションは削除されません**。これから来る新しいメッセージの振り分け方が変わるだけで、過去の会話は MulmoClaude の UI にそのまま残ります。

ただし `channel` → `thread` に切り替えると、それまで 1 本のチャネルセッションに蓄積されていたメッセージは、以後スレッド内返信が来ると新しいスレッドセッションとして作られます。古いチャネルセッションの文脈は自動では新セッションに引き継がれません。

---

## 既読リアクション (👀)

bridge が受信したメッセージに即座に絵文字リアクションを付ける機能。「bot がちゃんと届いていることを認識している」という安心感を、agent の返信を待たずにユーザへ返せます。デフォルトは OFF、`SLACK_ACK_REACTION` で opt-in。

| `SLACK_ACK_REACTION` の値 | 挙動 |
|---|---|
| 未設定 / 空 / `0` / `false` / `off` / `no` | OFF（デフォルト） |
| `1` / `true` / `on` / `yes` | ON、`:eyes:` でリアクション |
| 上記以外の絵文字ショートコード（コロン無し） | ON、その絵文字でリアクション |

絵文字ショートコードの書式: 小文字英字・数字・`_`・`+`・`-`。前後のコロンは付けない。標準絵文字 (`white_check_mark`, `thumbsup`) もカスタム絵文字 (`my_bot_ack`) も使えます。

```bash
# 例
SLACK_ACK_REACTION=1                    # 👀
SLACK_ACK_REACTION=white_check_mark     # ✅
SLACK_ACK_REACTION=my_bot_ack           # ワークスペースのカスタム絵文字
```

**Operator の設定**: **OAuth & Permissions** に `reactions:write` スコープを追加してアプリを再インストール。スコープが無い場合は `missing_scope` で失敗しますが、bridge は警告ログを出して処理を続けるので、他の動作には影響しません。

**設計**: リアクション呼び出しは fire-and-forget。agent 処理はリアクションの成否を待たずに即座に開始。返信が届いてもリアクションは残したまま (「既読」マーカーとして保持)。

---

## 環境変数

| 変数 | 必須 | 説明 |
|---|---|---|
| `SLACK_BOT_TOKEN` | はい | `xoxb-...` Bot User OAuth Token |
| `SLACK_APP_TOKEN` | はい | `xapp-...` App-Level Token (`connections:write`) |
| `SLACK_ALLOWED_CHANNELS` | いいえ | アクセスを許可するチャネル ID の CSV（空ならすべて許可） |
| `SLACK_SESSION_GRANULARITY` | いいえ | `channel`（デフォルト） / `thread` / `auto`。上記参照 |
| `SLACK_ACK_REACTION` | いいえ | デフォルト OFF。`1` で 👀 を付ける、他の絵文字ショートコードを指定するとその絵文字。有効化時は `reactions:write` スコープが必要。上記参照 |
| `SLACK_BRIDGE_DEFAULT_ROLE` | いいえ | 新規 bridge セッション作成時に初期適用するロール ID（例: `slack`、`coder`）。Slack セッションが **最初に現れたときだけ** 適用され、その後ユーザーが `/role <id>` でロールを切り替えた場合はそちらが優先されます。未知のロール ID は warn ログ付きでサーバーのデフォルトにフォールバックします。 |
| `BRIDGE_DEFAULT_ROLE` | いいえ | 上と同じですが、すべての bridge で共通です。両方セットされている場合は、transport 固有の `SLACK_BRIDGE_DEFAULT_ROLE` が優先されます。 |
| `MULMOCLAUDE_API_URL` | いいえ | 既定: 自動（`.server-port`、無ければ `http://localhost:3001`） |
| `MULMOCLAUDE_AUTH_TOKEN` | いいえ | Bearer token（未指定ならワークスペースから自動取得） |

### ブリッジオプションのパススルー

`SLACK_BRIDGE_*` および `BRIDGE_*` 環境変数は、camelCase のオプション bag として自動的にサーバーへ転送されます（例: `SLACK_BRIDGE_DEFAULT_ROLE=slack` → `options.defaultRole = "slack"`）。MulmoClaude サーバーは `defaultRole` を参照します。`@mulmobridge/client` を使う他のホストアプリは、プロトコルを変更せずに独自のキーを定義できます。仕様の全文は `plans/done/feat-bridge-options-passthrough.md` を参照してください。

## ライセンス

MIT
