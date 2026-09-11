# MulmoClaude

[![npm version](https://img.shields.io/npm/v/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![npm downloads](https://img.shields.io/npm/dm/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![License: MIT](https://img.shields.io/npm/l/mulmoclaude.svg)](LICENSE)
[![CI](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml/badge.svg)](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml)
[![GitHub stars](https://img.shields.io/github/stars/receptron/mulmoclaude.svg?style=social)](https://github.com/receptron/mulmoclaude/stargazers)

[English](README.md) · **日本語** · [简体中文](README.zh.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Português (BR)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

**あなたのことを何でも知っていて、24時間そばで仕事も生活も支えてくれる AI アシスタントは、どこにも売っていません。買うことはできない — 育てることしかできないのです。MulmoClaude は、そんな自分だけの AI アシスタントを、自分のパソコンの上で育てるためのツールです。**

アシスタントの実体は AI モデルではありません — モデルはエンジンにすぎません。アシスタントの価値を決めるのは、その人についてどれだけ知っているか。過去の会話、予定表、メモ、データ、そして使っているアプリです。それほど重要なものを、特定のサービスプロバイダーに任せるべきではありません。長く使えば使うほど、そのサービスから離れられなくなってしまうからです。MulmoClaude はオープンソースで、ローカルで動作します。アシスタントが蓄積するもの — 記憶も、データも、アプリも — すべてがワークスペース内のプレーンなファイルとして、ユーザー自身の手元に残ります。

育てるためには、環境が必要です。MulmoClaude はその環境を提供します。記憶を蓄積する場所（Claude が自ら構築し維持する個人 Wiki）、データを置く場所（スキーマ駆動のコレクション、フィード、プレーンなファイル）、そして自分専用のアプリを作る場所 — プログラミングの知識は要りません。「こういうものが欲しい」と普通の言葉で話すだけで、Claude が必要な小さなアプリを作ってくれます。レストランリスト、請求書トラッカー、単語練習 — どれも、たったひとりのためのソフトウェアです。インストールした直後の畑は、まだ空っぽです。そこに種をまき、耕しながら、自分だけのアシスタントを育てていくのです。

そして、アシスタントはパソコンの前にいる時だけのものではありません。スマートフォンから — あるいは普段使っているメッセージングアプリから — ログインすれば、パソコンの中に住んでいる同じアシスタントにつながります。中継サーバーが運ぶのは転送中のメッセージだけ — あなたの記憶も、データも、アプリも、パソコンの外に出ることはありません。

内部的には、MulmoClaude は AI ネイティブなアプリケーションプラットフォームです。各機能は単一のレジストリ内のプラグインとして構築され（現在は、実際のサーバーサイド簿記ロジックを備えた本格的な会計システム、個人 Wiki、SEC 申請書リーダーなど）、Claude はそれらを横断的に構成するユニバーサルコントローラーとして機能し、チャットがタスクに応じた適切な GUI を呼び出します — markdown、チャート、フォーム、Wiki、スプレッドシート、3D シーン。

> **[How AI-Native Applications Should Be Built](MANIFEST.md)** — MulmoClaude の背後にあるアーキテクチャ、UX、プロトコルに関する論考。

## 📣 アップデート情報

新バージョンや新機能のお知らせは X で発信しています。

- [Singularity Society (@SingularitySoci)](https://x.com/SingularitySoci) — リリース・新機能のお知らせ
- [中島聡 (@snakajima)](https://x.com/snakajima) — MulmoClaude のオーナー

## クイックスタート

```bash
npx mulmoclaude@latest
```

ランチャーがサーバを起動してブラウザで [http://localhost:3001](http://localhost:3001) を開きます。以上です — チャットを始めましょう。

> **バックグラウンドで動かしたい場合**: ターミナルを閉じるとサーバも終了します。常駐させるには `tmux` / `screen` (macOS/Linux) で起動するか、Windows ならタスクスケジューラのスタートアップタスクとして登録してください。

### 前提条件

- **Node.js 20 以降** — ランタイム
- **[Claude Code CLI](https://claude.ai/code)** — インストール・認証済みであること。`claude` を一度実行して OAuth を完了してください
- **ffmpeg** — 動画生成に必要です。動画を生成しない場合はスキップして構いません
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg`
- **Docker Desktop** (任意・推奨) — サンドボックスモードを有効化します。下記 [Docker Desktop のインストール](#docker-desktop-のインストール) を参照してください

> **UI 言語**: 英語、日本語、中国語、韓国語、スペイン語、ポルトガル語 (ブラジル)、フランス語、ドイツ語の 8 言語に対応しています。デフォルトではブラウザ / OS の言語設定から自動判定されます。明示的に指定する場合は `.env` に `VITE_LOCALE=ja` を設定してください (日本語辞書 `src/lang/ja.ts` が使用されます)。ロケールはビルド / 開発時に決定されるため、変更後は `yarn dev` を再起動してください。文字列の追加方法は [`docs/developer.md`](docs/developer.md#i18n-vue-i18n) を参照してください。

### ソースから実行する (開発者向け)

コードを修正しながら動かしたい場合:

```bash
git clone git@github.com:receptron/mulmoclaude.git
cd mulmoclaude && yarn install
cp .env.example .env   # 任意 — 画像生成に GEMINI_API_KEY を追加
yarn dev
```

[http://localhost:5173](http://localhost:5173) を開いてください。アーキテクチャやスクリプトの詳細は [`docs/developer.md`](docs/developer.md) を参照してください。

> **UI が崩れる・スタイルが当たらない場合**: アイコンが文字で表示される、`dist/*` が 404、再起動後に `401` — [`docs/troubleshooting.md`](docs/troubleshooting.md) を参照してください。

## 何ができるの?

| Claude にこう頼むと...                           | 得られるもの                                         |
| ------------------------------------------------ | ---------------------------------------------------- |
| 「プロジェクト提案書を書いて」                   | キャンバスに表示されるリッチな Markdown ドキュメント |
| 「前四半期の売上をグラフにして」                 | インタラクティブな ECharts ビジュアライゼーション    |
| 「京都の旅行プランを作って」                     | 画像付きのイラスト入りガイド                         |
| 「ToDo リストを作って」                          | Kanban ボード付きのスキーマ駆動コレクション          |
| 「この記事を取り込んで: URL」                    | 長期記憶のための `[[links]]` 付き Wiki ページ        |
| 「毎日のニュースダイジェストをスケジュールして」 | 自動実行される繰り返しタスク                         |
| 「夕日の画像を生成して」                         | AI 生成画像 (Gemini)                                 |
| 「この RSS フィードを購読して」                  | `/feeds` にデータフィードとして登録、スケジュール取得 |
| 「フィードの新着を見せて」                       | `/feeds` に集約されたフィード項目                     |

> **直接アクセスできるページ**: `/wiki`（閲覧 + Lint）、`/feeds`（データフィード）、`/collections`（データアプリ）、`/automations`（繰り返しタスク）、`/files`、`/skills`、`/roles`。各ページに専用のチャットコンポーザがあり、ページのコンテキストを自動で取り込んだ新規チャットを起動できます。

> **MulmoClaude を触ってみたい?** 環境変数、スクリプト、アーキテクチャについては [`docs/developer.md`](docs/developer.md) を参照してください。

<a id="messaging-bridges"></a>
### メッセージングブリッジ

MulmoClaude は **ブリッジプロセス** を経由してメッセージングアプリからアクセスできます。ブリッジは別の子プロセスとして実行され、socket.io 経由でサーバーに接続します。

```bash
# Interactive CLI bridge (same machine)
yarn cli

# Telegram bot bridge (requires TELEGRAM_BOT_TOKEN in .env)
yarn telegram
```

ブリッジはスタンドアロンの npm パッケージとしても提供されています:

```bash
# Chat platforms
npx @mulmobridge/cli@latest          # CLI bridge
npx @mulmobridge/telegram@latest     # Telegram bridge
npx @mulmobridge/slack@latest        # Slack bridge
npx @mulmobridge/discord@latest      # Discord bridge
npx @mulmobridge/line@latest         # LINE bridge
npx @mulmobridge/whatsapp@latest     # WhatsApp bridge
npx @mulmobridge/matrix@latest       # Matrix bridge
npx @mulmobridge/irc@latest          # IRC bridge
npx @mulmobridge/mattermost@latest   # Mattermost bridge
npx @mulmobridge/zulip@latest        # Zulip bridge
npx @mulmobridge/messenger@latest    # Facebook Messenger bridge
npx @mulmobridge/google-chat@latest  # Google Chat bridge
npx @mulmobridge/mastodon@latest     # Mastodon bridge
npx @mulmobridge/bluesky@latest      # Bluesky bridge
npx @mulmobridge/chatwork@latest     # Chatwork bridge (Japanese business chat)
npx @mulmobridge/xmpp@latest         # XMPP / Jabber bridge
npx @mulmobridge/rocketchat@latest   # Rocket.Chat bridge
npx @mulmobridge/signal@latest       # Signal bridge (via signal-cli-rest-api)
npx @mulmobridge/teams@latest        # Microsoft Teams bridge (Bot Framework)
npx @mulmobridge/line-works@latest   # LINE Works bridge (enterprise LINE)
npx @mulmobridge/nostr@latest        # Nostr encrypted DM bridge
npx @mulmobridge/viber@latest        # Viber bridge

# Universal / glue
npx @mulmobridge/webhook@latest      # Generic HTTP webhook (dev glue)
npx @mulmobridge/twilio-sms@latest   # SMS via Twilio
npx @mulmobridge/email@latest        # Email bridge (IMAP + SMTP)
```

すべてのブリッジは **リアルタイムテキストストリーミング** (エージェントが書き込むのに合わせて入力中表示が更新される) をサポートします。CLI と Telegram はさらに **ファイル添付** (画像、PDF、DOCX、XLSX、PPTX) もサポートしています。対応プラットフォームの全一覧とセットアップ方法は [`docs/mulmobridge-guide.md`](docs/mulmobridge-guide.md) を参照してください。

#### 長期運用ブリッジの認証トークン保持

MulmoClaude サーバは起動するたびに新しい bearer トークンを生成して `<workspace>/.session-token`（`$MULMOCLAUDE_WORKSPACE_PATH`、未設定なら `~/mulmoclaude`）に書き出します。ブリッジは起動時にこのファイルを 1 回だけ読んでトークンをメモリに保持するため、**サーバ再起動を挟むとブリッジは古いトークンを使い続け、すべての API 呼び出しが 401 で静かに失敗します**。

**対策**: サーバとブリッジの **両方** に同じ長いランダム文字列を `MULMOCLAUDE_AUTH_TOKEN` 環境変数で渡してください。サーバは自動生成ではなくこの値をそのまま使うので、再起動を跨いでもトークンが変わらず、ブリッジは認証され続けます。

```bash
# サーバ (起動毎に同じ値を渡す)
MULMOCLAUDE_AUTH_TOKEN=長めのランダム文字列 yarn dev

# ブリッジ (別プロセス / 別マシン、同じ値)
MULMOCLAUDE_AUTH_TOKEN=長めのランダム文字列 \
  TELEGRAM_BOT_TOKEN=... \
  npx @mulmobridge/telegram@latest
```

推奨は **32 文字以上のランダム文字列** です (短い値だとサーバ起動時に警告が出ます)。

### なぜ Gemini API キーが必要なの?

MulmoClaude は画像生成・編集に Google の **Gemini 3.1 Flash Image (nano banana 2)** モデルを使用しています。これにより以下が実現します:

- `generateImage` — テキスト記述から画像を生成する
- `editImage` — 既存の画像を変換・修正する (例: 「Ghibli スタイルに変換」)
- ドキュメントに埋め込まれるインライン画像 (Recipe Guide、Trip Planner など)

Gemini API キーがない場合、画像生成を使用するロールは UI で無効化されます。

### Gemini API キーの取得方法

1. [Google AI Studio](https://aistudio.google.com/apikey) にアクセス
2. Google アカウントでサインイン
3. **Create API key** をクリック
4. キーをコピーして `.env` ファイルに `GEMINI_API_KEY=...` として貼り付ける

Gemini API には個人利用に十分な無料枠があります。

<a id="security"></a>
## セキュリティ

MulmoClaude は AI バックエンドとして Claude Code を使用しており、Bash を含むツールにアクセスできます — つまりマシン上のファイルを読み書きできます。

**Docker を使わない場合**、Claude はあなたのユーザーアカウントが到達できるすべてのファイル (ワークスペースの外に保存されている SSH キーや資格情報を含む) にアクセスできます。個人のローカル利用では許容できますが、理解しておく価値があります。

**Docker Desktop がインストールされている場合**、MulmoClaude は自動的に Claude をサンドボックス化されたコンテナ内で実行します。マウントされるのはワークスペースと Claude 自身の設定 (`~/.claude`) のみ — 残りのファイルシステムは Claude からは見えません。設定は不要です: アプリは起動時に Docker を検出し、自動的にサンドボックスを有効化します。

**Bearer トークン認証**: すべての `/api/*` エンドポイントは `Authorization: Bearer <token>` ヘッダーを要求します。トークンはサーバー起動時に自動生成され、`<meta>` タグ経由でブラウザに注入されます — 手動設定は不要です。唯一の例外は `/api/files/*` です (レンダリングされたドキュメント内の `<img>` タグはヘッダーを付与できないため免除)。詳細は [`docs/developer.md`](docs/developer.md#auth-bearer-token-on-api) を参照してください。

**サンドボックスへの資格情報フォワーディング** (オプトイン): デフォルトではサンドボックスはホストの資格情報にアクセスできません。2 つの環境変数で、`git` / `gh` が必要とするものだけを選択的に公開できます:

- `SANDBOX_SSH_AGENT_FORWARD=1` — ホストの SSH エージェントソケットを転送します。秘密鍵はホスト上に残ります。
- `SANDBOX_MOUNT_CONFIGS=gh,gitconfig` — `~/.config/gh` と `~/.gitconfig` を読み取り専用でマウントします。

完全な仕様とセキュリティ上の注意: [`docs/sandbox-credentials.md`](docs/sandbox-credentials.md)。

### Docker Desktop のインストール

1. [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) から Docker Desktop をダウンロード
2. **macOS**: `.dmg` を開いて Docker を Applications にドラッグし、Applications から起動
3. **Windows**: インストーラーを実行し、画面の指示に従う (必要に応じて WSL2 が自動セットアップされます)
4. **Linux**: [Linux インストールガイド](https://docs.docker.com/desktop/install/linux/) に従う
5. Docker Desktop の起動が完了するのを待つ — メニューバー / システムトレイのクジラアイコンが (アニメーションではなく) 安定した状態になるはず
6. MulmoClaude を再起動 — Docker を検出し、初回起動時にサンドボックスイメージをビルドします (一度だけ、約 1 分かかります)

macOS で Docker サンドボックスがアクティブなとき、資格情報は自動的に管理されます — アプリは起動時にシステム Keychain から OAuth トークンを抽出し、401 エラー時には更新します。手動操作は不要です。

Docker がインストールされていない場合、アプリは警告バナーを表示しますが、サンドボックスなしで引き続き動作します。

> **デバッグモード**: Docker がインストールされている場合でもサンドボックスなしで実行するには、サーバー起動前に `DISABLE_SANDBOX=1` を設定するか、CLI フラグ `--disable-sandbox`（`yarn dev --disable-sandbox` / `npx mulmoclaude --disable-sandbox`、Windows PowerShell でも可）を渡してください。
>
> **ツール呼び出し履歴**: `PERSIST_TOOL_CALLS=1` を設定すると、`tool_result` と並んで `tool_call` イベント(`args` 含む)もセッション jsonl に記録されます。`args` は大きくなりがちで、ディスクに残したくないペイロード(画像 base64、MulmoScript JSON など)を含む可能性があるためデフォルトでは off。ページ更新やサーバー再起動後のデバッグに有用です。詳細は [issue #1096](https://github.com/receptron/mulmoclaude/issues/1096) を参照。

## ロギング

サーバーは読みやすいテキストをコンソールに、完全な JSON を `server/system/logs/` 配下の日次ローテーションファイルに書き込みます。すべては `LOG_LEVEL`、`LOG_*_FORMAT`、`LOG_FILE_DIR` などで設定可能です。

完全なリファレンス、フォーマット例、ローテーション動作、レシピについては [docs/logging.md](docs/logging.md) を参照してください。

## ロール

各ロールは Claude に異なるペルソナ、ツールセット、重点領域を与えます:

| ロール              | 役割                                                                      |
| ------------------- | ------------------------------------------------------------------------- |
| **General**         | 汎用アシスタント — ToDo、スケジューラ、Wiki、ドキュメント、マインドマップ |
| **Office**          | ドキュメント、スプレッドシート、フォーム、プレゼン、データダッシュボード  |
| **Guide & Planner** | 旅行ガイド、レシピブック、旅程プランナーをリッチなビジュアル出力で作成    |
| **Artist**          | 画像生成、画像編集、p5.js によるジェネラティブアート                      |
| **Tutor**           | 適応型指導 — 説明前にあなたのレベルを評価する                             |
| **Storyteller**     | 画像と HTML シーンを備えたインタラクティブなイラストストーリー            |

ロールを切り替えると Claude のコンテキストがリセットされ、そのロールに必要なツールだけに差し替えられます — 応答を高速かつ焦点の定まったものに保ちます。

## Skills — Claude Code Skills を MulmoClaude から実行する

MulmoClaude はすでにお持ちの **Claude Code skills** を一覧表示し、起動できます。skill とは、YAML フロントマターに `description` を持ち、Markdown 本文に指示を記述した `SKILL.md` ファイルを含む `~/.claude/skills/<name>/` 配下のフォルダのことです。skill の作成方法の詳細は [Claude Code Skills ドキュメント](https://docs.claude.com/en/docs/claude-code/skills) を参照してください。

### 使い方

1. MulmoClaude を開き、skill が有効なロールのいずれかに留まります: **General**、**Office**、または **Tutor**。
2. Claude に skill を表示するよう頼みます — 例: _「show my skills」_ や _「list skills」_。
3. Claude が `manageSkills` ツールを呼び出し、キャンバスに分割ペインの **Skills** ビューが開きます:
   - **左**: マシン上で検出されたすべての skill、その説明、スコープバッジ (`USER` / `PROJECT`)。
   - **右**: 選択された skill の `SKILL.md` の完全な内容。
4. skill の **Run** をクリックします。MulmoClaude は通常のチャットメッセージとして `/<skill-name>` を Claude に送信します。Claude Code のスラッシュコマンド機能がそれを `~/.claude/skills/` に対して解決し、skill の指示を同じチャットセッション内でインラインに実行します。

余計な入力もコピー & ペーストも不要 — Run ボタンは `/skill-name` のワンクリックラッパーです。

### skill の発見 — 2 つのスコープ

| スコープ    | 場所                                   | 意味                                                                                                   |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **User**    | `~/.claude/skills/<name>/SKILL.md`     | 個人用の skill。Claude CLI で開くあらゆるプロジェクト間で共有されます。                                |
| **Project** | `~/mulmoclaude/.claude/skills/<name>/` | MulmoClaude ワークスペーススコープの skill。名前が user と衝突した場合、project が **優先** されます。 |

フェーズ 0 では両スコープとも読み取り専用です — 編集はファイルシステム上で行います。将来のリリースで MulmoClaude 自身が project スコープの skill を作成 / 編集できるようになります。

### Docker サンドボックス vs 非 Docker

MulmoClaude のデフォルトの **Docker サンドボックスモード** は安全性のため Claude Code をコンテナ内に隔離します ([セキュリティ](#security) を参照)。skill の動作は 2 つのモード間で異なります:

| モード                               | User skills (`~/.claude/skills/`) | Project skills (`~/mulmoclaude/.claude/skills/`) | 組み込み CLI skills (`/simplify`, `/update-config`, …) |
| ------------------------------------ | --------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| **Non-Docker** (`DISABLE_SANDBOX=1`) | ✅ すべて動作                     | ✅                                               | ✅                                                     |
| **Docker sandbox** (デフォルト)      | ⚠️ 下記の注意事項を参照           | ✅ ワークスペースボリューム経由でマウント        | ✅                                                     |

**Docker 上の注意事項 — サンドボックス内でユーザー skill が機能しないことがある理由:**

- **シンボリックリンクされた `~/.claude/skills/`** — `~/.claude/skills` (またはサブエントリ) が `~/.claude/` の外を指すシンボリックリンクの場合 (例: `~/.claude/skills → ~/ss/dotfiles/claude/skills`)、そのリンクのターゲットはコンテナ内に存在しません。リンクは **デッドリンク** として現れ、Claude Code は組み込み skill のみにフォールバックします。
- **サンドボックスイメージ内の古い Claude CLI** — `Dockerfile.sandbox` はイメージビルド時に CLI バージョンを固定します。そのバージョンがホスト CLI より古い場合 (例: イメージ内 2.1.96 vs ホスト上 2.1.105)、ユーザー skill の発見動作が異なることがあります。

**サンドボックスとうまく動作しない skill の豊富なセットアップへの回避策:**

1. **このセッション用にサンドボックスを無効化する**:

   ```bash
   # env-var form (any shell supporting VAR=value)
   DISABLE_SANDBOX=1 yarn dev

   # or the equivalent --disable-sandbox CLI flag (Windows PowerShell / npx / IDE run configs)
   yarn dev --disable-sandbox
   npx mulmoclaude --disable-sandbox
   ```

   Claude CLI は実際の `~/.claude/` で実行され、すべてがネイティブに解決されます。送ろうとしているプロンプトを信頼できる場合に使用してください — 信頼できない / 探索的な作業にはサンドボックスが依然として推奨デフォルトです。

2. **skill を project スコープに移す** — 使いたい特定の skill を `~/mulmoclaude/.claude/skills/` にコピーします (このパスはサンドボックス内でワークスペースボリュームとしてマウントされるため、シンボリックリンクの問題はありません)。そもそも MulmoClaude ワークフロー固有の skill にはうってつけです。

3. **シンボリックリンクをフラット化する** — skill ライブラリをシンボリックリンク経由で管理している場合 (例: dotfiles リポジトリ内)、最上位の `~/.claude/skills` シンボリックリンクを実際のディレクトリに置き換えるのが最もシンプルな修正です。

### skill が実際に受け取るもの

**Run** を押すと、MulmoClaude はスラッシュコマンド文字列を含むプレーンなユーザーターンを送信します:

```text
/my-skill-name
```

これがペイロードのすべてです — MulmoClaude は `SKILL.md` 本文や追加のコンテキストを **インライン化しません**。本文は CLI がスラッシュコマンドを自身の側で解決するときに Claude Code が読み取るものです。これによりチャット入力を小さく保ち、長い skill (数キロバイトの `SKILL.md`) でもプロンプトコンテキストを肥大化させずに安全に実行できます。

### 会話を新しい skill として保存する

生産的なチャットのあと、MulmoClaude にワークフローをキャプチャするよう頼めます:

```text
"この会話を fix-ci という skill にして"
"save this as a skill called publish-flow"
"skill 化して"   ← Claude picks a slug for you
```

Claude は現在のチャットトランスクリプトを読み、あなたが取ったステップを蒸留し、新しい `SKILL.md` を `~/mulmoclaude/.claude/skills/<slug>/` に書き込みます。skill はすぐに Skills ビューに現れ、以降のセッションで `/<slug>` 経由で呼び出せます。

保存に関する注意点:

- **Project スコープのみ** — 保存先は `~/mulmoclaude/.claude/skills/` のみで、`~/.claude/skills/` にはなりません。user スコープは MulmoClaude からは読み取り専用のままです。
- **上書きなし** — 同じ名前の skill が (いずれかのスコープに) 既に存在する場合、保存は失敗し、Claude は別の名前を尋ねます。
- **Slug ルール** — 小文字、数字、ハイフン。1〜64 文字。先頭 / 末尾のハイフンや連続するハイフンは不可。Claude が自動で選びます。特定の名前がほしい場合はリクエスト内で言及してください。

### 保存した skill を削除する

Project スコープの skill には Skills ビュー内の Run ボタンの隣に **Delete** ボタンが表示されます (user スコープの skill は読み取り専用のため Delete ボタンは表示されません)。ダイアログを確認すると `~/mulmoclaude/.claude/skills/<slug>/SKILL.md` が削除されます。そのフォルダに手動で追加のファイルを置いている場合、それらはそのまま残されます。削除されるのは SKILL.md のみです。

Claude に名前で削除を頼むこともできます:

```text
"delete the fix-ci skill"
```

## Wiki — Claude Code のための長期記憶

MulmoClaude には [Andrej Karpathy の LLM Knowledge Bases のアイデア](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) にインスパイアされた **個人ナレッジベース** が含まれています。これにより Claude Code に真の長期記憶が与えられます — 短い `memory.md` だけでなく、Claude 自身が構築・維持する、成長していく相互接続された Wiki です。

**General** ロールには Wiki サポートが組み込まれています。次のように試してみてください:

- `"Ingest this article: <URL>"` — Claude がページを取得し、重要な知識を抽出し、Wiki ページを作成または更新し、アクティビティをログに記録します
- `"What does my wiki say about transformers?"` — Claude がインデックスを検索し、関連するページを読み、根拠のある答えを合成します
- `"Lint my wiki"` — 孤立ページ、壊れたリンク、不足しているインデックスエントリのヘルスチェック
- `"Show me the wiki index"` — 完全なページカタログをキャンバスにレンダリング

### 仕組み

Wiki はワークスペース内のプレーンな Markdown ファイルとして完全に存在します:

```
<workspace>/data/wiki/
  index.md          ← catalog of all pages (title, description, last updated)
  log.md            ← append-only activity log
  pages/<slug>.md   ← one page per entity, concept, or theme
  sources/<slug>.md ← raw ingested sources
```

Claude は組み込みのファイルツール (`read`、`write`、`glob`、`grep`) を使って Wiki を操作・維持します — 特別なデータベースやインデックス化は不要です。相互参照は `[[wiki link]]` 構文を使い、キャンバス UI ではクリック可能なナビゲーションとしてレンダリングされます。

時間の経過とともに、Wiki はどのロールからも参照できる個人ナレッジベースへと成長し、使えば使うほど Claude がどんどん便利になります。

## チャート (ECharts)

`presentChart` プラグインはキャンバスに [Apache ECharts](https://echarts.apache.org/) ビジュアライゼーションをレンダリングします。折れ線、棒、ローソク足、サンキー、ヒートマップ、ネットワーク / グラフを依頼すると — Claude が ECharts のオプションオブジェクトを書き、プラグインがそれをマウントします。すべてのチャートにはワンクリックでエクスポートできる **[↓ PNG]** ボタンがあります。

**General**、**Office**、**Guide & Planner**、**Tutor** ロールで利用可能です。次のように試してみてください:

```text
Chart last quarter's revenue by region as a bar chart
Plot AAPL's daily closes for the last 30 days as a candlestick
Show a sankey of energy flow: coal/gas/solar → electricity → home/industry/transport
```

### 保存

`presentChart` を呼び出すたびに、`<workspace>/artifacts/charts/` 配下に 1 つのファイルが書き込まれます:

```text
<workspace>/artifacts/charts/
  sales-overview-1776135210389.chart.json
  apple-stock-1776135300000.chart.json
```

1 つのドキュメントには任意の数のチャートを含めることができ、キャンバスに縦に積み重ねてレンダリングされます:

```json
{
  "title": "Apple Stock Analysis",
  "charts": [
    {
      "title": "Daily close",
      "type": "line",
      "option": {
        "xAxis": {
          "type": "category",
          "data": ["2024-01", "2024-02", "2024-03"]
        },
        "yAxis": { "type": "value" },
        "series": [{ "type": "line", "data": [180, 195, 210] }]
      }
    },
    {
      "title": "Volume",
      "type": "bar",
      "option": {
        "xAxis": {
          "type": "category",
          "data": ["2024-01", "2024-02", "2024-03"]
        },
        "yAxis": { "type": "value" },
        "series": [{ "type": "bar", "data": [1000000, 1200000, 950000] }]
      }
    }
  ]
}
```

`option` フィールドはそのまま ECharts の [`setOption`](https://echarts.apache.org/en/api.html#echartsInstance.setOption) に渡されます — これらのファイルを手で編集するときは [ECharts オプションリファレンス](https://echarts.apache.org/en/option.html) の全体を参照できます。編集は、次回ドキュメントをキャンバスで再度開いたときに反映されます。

## オプション: X (Twitter) MCP ツール

MulmoClaude には、公式 X API v2 経由で X (Twitter) の投稿を読み取り・検索するためのオプションの MCP ツールが含まれています。

| ツール      | 役割                                            |
| ----------- | ----------------------------------------------- |
| `readXPost` | URL またはツイート ID から 1 つの投稿を取得する |
| `searchX`   | キーワードまたはクエリで最近の投稿を検索する    |

これらのツールは **デフォルトでは無効** で、アクティブにするには X API Bearer Token が必要です。

### セットアップ

1. [console.x.com](https://console.x.com) にアクセスし、X アカウントでサインイン
2. 新しいアプリを作成 — Bearer Token が自動生成されます
3. Bearer Token をコピーして `.env` に追加:
   ```
   X_BEARER_TOKEN=your_bearer_token_here
   ```
4. [console.x.com](https://console.x.com) でアカウントにクレジットを追加する (API 呼び出しを行うために必要)
5. 開発サーバーを再起動 — ツールは自動的にアクティブになります

### 使い方

これらのツールは **カスタムロールでのみ利用可能** です。組み込みロールにはデフォルトでは含まれていません (General を除く)。自分のロールで使うには:

1. `~/mulmoclaude/roles/<id>.json` にカスタムロールの JSON ファイルを作成または編集する
2. その `availablePlugins` リストに `readXPost` および / または `searchX` を追加

設定後は、任意の `x.com` または `twitter.com` URL をチャットに貼り付けるだけで、Claude が自動的に取得・読み取りします。

## 追加ツールの設定 (Web 設定)

サイドバーの歯車アイコンから Settings モーダルを開くと、コードを編集することなく Claude のツールセットを拡張できます。変更は次のメッセージから適用されます (サーバーの再起動不要)。

### Allowed Tools タブ

ツール名を 1 行に 1 つずつ貼り付けます。Claude Code の組み込み MCP サーバー (Gmail、Google Calendar) を一度きりの OAuth ハンドシェイクのあとで使うのに便利です:

```text
mcp__claude_ai_Gmail
mcp__claude_ai_Google_Calendar
```

最初にターミナルで `claude mcp` を 1 回実行し、各サービスに対して OAuth フローを完了してください — 資格情報は `~/.claude/` 配下に保存されます。

### MCP Servers タブ

JSON を手で編集することなく外部 MCP サーバーを追加できます。2 つのタイプをサポートしています:

- **HTTP** — リモートサーバー (例: `https://example.com/mcp`)。どのモードでも動作します。Docker では `localhost` / `127.0.0.1` URL は自動的に `host.docker.internal` に書き換えられます。
- **Stdio** — ローカルサブプロセス (例: `npx` の MCP)。安全のため `npx` / `node` / `tsx` に制限されます。Docker サンドボックスが **オフ** のときはホスト上で動きます。**オン** のときは stdio エントリは **既定で破棄されます** (最小構成のサンドボックスイメージでは任意のランタイムを動かせないため) — 代わりに `"hostExecInDocker": true` を設定すると、そのサーバーをホスト上で `stdio ↔ HTTP` ゲートウェイ越しに動かせます。[docs/mcp-sandbox.ja.md](docs/mcp-sandbox.ja.md) を参照。

stdio サーバーへの認証情報は **`env`** マップで渡します (`"env": { "IMAP_PASS": "…" }`)。値はリテラルで `mcp.json` に保存されます (mode `0600` ですが **平文** — vault ではなくファイル権限による保護)。`hostExecInDocker` の opt-in や `env` がプロセスに届く仕組みなど詳細は [docs/mcp-sandbox.ja.md](docs/mcp-sandbox.ja.md) にあります。

設定は `<workspace>/config/` 配下にあります:

```text
<workspace>/config/
  settings.json    ← extra allowed tool names
  mcp.json         ← Claude CLI --mcp-config compatible
```

MCP ファイルは Claude CLI の標準フォーマットを使用するため、マシン間でコピーしたり、`claude` CLI で直接使うこともできます。

### 設定ファイルを直接編集する

どちらのファイルもプレーンな JSON です — Settings UI の代わりに任意のテキストエディタで編集できます。サーバーはメッセージごとに再読み込みするため:

- ファイル編集後にサーバー再起動は不要です。
- 変更は Settings UI にも反映されます — モーダルを閉じて開き直すだけ。
- UI とファイルは常に同期します: UI から保存するとファイルが上書きされ、手動編集は次回開いたときに UI に現れます。

これは次のような場合に便利です:

- 別のワークステーションから MCP サーバーを一括インポートする (`mcp.json` をコピーするだけ)。
- dotfiles リポジトリでセットアップをバージョン管理する。
- `"enabled": false` に切り替えて一時的にサーバーをコメントアウトする。

**`mcp.json` の例** — 1 つのリモート HTTP サーバー (公開、認証なし) と 1 つのローカル stdio サーバー:

```json
{
  "mcpServers": {
    "deepwiki": {
      "type": "http",
      "url": "https://mcp.deepwiki.com/mcp",
      "enabled": true
    },
    "everything": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "enabled": true
    }
  }
}
```

ファイル読み込み時にサーバーが強制する制約:

- `mcpServers` のキー (サーバー id) は `^[a-z][a-z0-9_-]{0,63}$` にマッチする必要があります。
- HTTP `url` は `http:` または `https:` としてパースできる必要があります。
- Stdio `command` は `npx`、`node`、`tsx` に制限されます。
- 検証に失敗したエントリは読み込み時に暗黙的に破棄されます (警告がログに記録されます)。残りのファイルは引き続き適用されます。

**例** — 認証情報を持ち、Docker サンドボックス下でも動く stdio サーバー (例: IMAP MCP):

```json
{
  "mcpServers": {
    "imap": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-imap-mcp"],
      "env": { "IMAP_HOST": "imap.example.com", "IMAP_USER": "me", "IMAP_PASS": "secret" },
      "hostExecInDocker": true,
      "enabled": true
    }
  }
}
```

`hostExecInDocker` はそのサーバーをホスト上 (サンドボックス外) で動かします。サーバー単位のフラグなので、必要なだけ複数のサーバーに設定できますが、信頼できるものだけにしてください。サンドボックスがオフのときは無視されます (サーバーはすでにホスト上で動くため)。

**`settings.json` の例**:

```json
{
  "extraAllowedTools": ["mcp__claude_ai_Gmail", "mcp__claude_ai_Google_Calendar"]
}
```

`mcp.json` で定義したサーバーについては `mcp__<id>` エントリを列挙する必要はありません — それらはエージェント実行ごとに自動的に許可されます。`extraAllowedTools` は、あなた自身の `mcpServers` からは到達できないツール用であり、典型的には `claude mcp` を実行して OAuth を完了したあとの Claude Code 組み込みの `mcp__claude_ai_*` ブリッジのためのものです。

## チャット添付

チャット入力にファイルを貼り付け (Ctrl+V / Cmd+V) したり、ドラッグ & ドロップしたりして、メッセージと一緒に Claude に送信できます。

| ファイル種別                                          | Claude が見るもの                           | 依存関係                            |
| ----------------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| 画像 (PNG, JPEG, GIF, WebP, …)                        | ビジョンコンテンツブロック (ネイティブ)     | なし                                |
| PDF                                                   | ドキュメントコンテンツブロック (ネイティブ) | なし                                |
| テキスト (.txt, .csv, .json, .md, .xml, .html, .yaml) | デコードされた UTF-8 テキスト               | なし                                |
| DOCX                                                  | 抽出されたプレーンテキスト                  | `mammoth` (npm)                     |
| XLSX                                                  | シートごとの CSV                            | `xlsx` (npm)                        |
| PPTX                                                  | PDF に変換                                  | LibreOffice (Docker サンドボックス) |

PPTX 変換は Docker サンドボックスイメージ内 (`libreoffice --headless`) で実行されます。Docker がない場合、代わりに PDF または画像へのエクスポートを提案するメッセージが表示されます。添付ファイルの最大サイズは 30 MB です。

## キャンバスのビューモード

キャンバス (右パネル) は 8 つのビューモードをサポートしており、ランチャーツールバー、URL クエリパラメータ、またはキーボードショートカットで切り替えられます:

| ショートカット | ビュー    | URL パラメータ    | 説明                                         |
| -------------- | --------- | ----------------- | -------------------------------------------- |
| `Cmd/Ctrl+1`   | Single    | (デフォルト)      | 選択したツールの結果を表示                   |
| `Cmd/Ctrl+2`   | Stack     | `?view=stack`     | すべての結果を縦に積み重ねて表示             |
| `Cmd/Ctrl+3`   | Files     | `?view=files`     | ワークスペースのファイルエクスプローラ       |
| `Cmd/Ctrl+5`   | Scheduler | `?view=scheduler` | スケジュールタスクのカレンダー               |
| `Cmd/Ctrl+6`   | Wiki      | `?view=wiki`      | Wiki ページインデックス                      |
| `Cmd/Ctrl+7`   | Skills    | `?view=skills`    | skill 一覧とエディタ                         |
| `Cmd/Ctrl+8`   | Roles     | `?view=roles`     | ロール管理                                   |

すべてのビューモードは URL 駆動です: ランチャーボタンをクリックすると `?view=` が更新され、(例えば) `?view=wiki` の URL で開くと対応するビューが復元されます。ビューモードのリストは `src/utils/canvas/viewMode.ts` で一度だけ定義されています — 新しいモードの追加は配列への追記 1 つで済みます。

## リモートアクセス

実行中の MulmoClaude に、スマートフォン（や任意のブラウザ）からアクセスできます。コレクション・フィード・カスタムビューの閲覧やチャットの開始を、どこからでも行えます。専用のアカウントやサーバーを用意する必要はありません。**両方の端末で同じ Google アカウントでサインインする**だけでアクセスが有効になります。

**接続方法**

1. デスクトップでヘッダーの **phonelink** アイコンをクリックして _リモートホスト_ のポップオーバーを開き、**Google でサインイン** を選びます。MulmoClaude がその Google ユーザーとしてサインインし、Firebase（共有の公開プロジェクト [`mulmoserver`](https://mulmoserver.web.app)）経由でコマンドチャネルを開きます。ホストがオンラインの間、アイコンは緑色になります。
2. スマートフォンで **[https://mulmoserver.web.app](https://mulmoserver.web.app)** を開き、**同じ Google アカウント**でサインインします。ウェブアプリがオンラインのホストを見つけて接続します。

両端が同じ Firebase ユーザーとして認証されるため、スマートフォンとデスクトップは自分専用のユーザー空間の中でのみ通信します。第三者がホストにアクセスすることはできません。

**Firebase と Firestore は通信の中継（トランスポート）としてのみ利用します** — スマートフォンとデスクトップの間でコマンドと応答をやり取りするための中継です。ユーザーのデータがどちらかに**保存・保持されることは一切ありません**。ホスト上に存在するのはローカルのワークスペースファイルだけで、チャネルを通過する必要があるもの（Firebase Storage を経由する添付ファイルなど）は、宛先に届いた時点で削除されます。

**スマートフォンからできること**

- **コレクション**や**フィード**の閲覧・ページ送り。
- **カスタムリモートビュー**（Claude が作成するモバイル向けのページ）を開く。通常のカスタムビューではなく _custom remote view_ を作るよう Claude に依頼してください。読み取り専用にも書き込み可能にもできます。
- ホストで**チャットを開始**し、スマートフォンから**写真・動画・PDF** を添付する。添付ファイルのバイト列はコマンドチャネルには大きすぎるため、Firebase Storage を経由します。ホストはそれをワークスペース（`data/attachments/`）にダウンロードし、中継用のコピーを削除して、メッセージとともに Claude に渡します。

このチャネルはコマンドベースでホスト主導です。スマートフォンがリクエストを送り、デスクトップの MulmoClaude が応答します。ホストをオフラインにするには、ポップオーバーの **切断** を使うか、MulmoClaude を終了してください。

## ワークスペース

すべてのデータはワークスペースディレクトリ内のプレーンファイルとして保存され、4 つのセマンティックなバケットにグループ化されています (#284):

```
~/mulmoclaude/
  config/              ← settings.json, mcp.json, roles/, helps/
  conversations/       ← chat/, memory.md, summaries/, searches/
  data/                ← wiki/, todos/, calendar/, contacts/, scheduler/,
                         sources/, transports/
  artifacts/           ← charts/, documents/, html/, html-scratch/,
                         images/, news/, spreadsheets/, stories/
```

完全なリファレンスは [`docs/developer.md`](docs/developer.md#workspace-layout-mulmoclaude) を参照してください。

### ToDo リスト

ToDo リストは専用ビューではなく、スキーマ駆動の **コレクション** として構築します。Claude に「ToDo リストを作って」と頼むと、`config/helps/todo-collection.md` に従って `todos` コレクションを作成します — ステータス enum (`Backlog / Todo / In Progress / Done`)、`done` トグル、任意の優先度 / 期限フィールドを持ち、スキーマに応じて kanban / テーブル / カレンダービューが自動的に選択されます。

### スケジューラと skill のスケジューリング

スケジューラ (`Cmd/Ctrl+5` または `?view=scheduler`) は `data/scheduler/items.json` に保存された繰り返しタスクを管理します。スケジューラのコア (`@receptron/task-scheduler`) は実行されなかったタスクのキャッチアップロジックを処理し、`interval`、`daily`、`cron` のスケジュールをサポートします。

skill は SKILL.md フロントマターに `schedule` フィールドを追加することで自動実行するようにスケジュールできます:

```yaml
---
description: Morning news digest
schedule: daily 08:00
---
```

Claude が skill をスケジューラに登録し、指定されたスケジュールで自動的に実行されます。

### メモリ抽出

Claude はチャット会話からユーザーの永続的な事実を自動的に抽出し、`conversations/memory.md` に追記します。これは日次ジャーナルパスの一部として実行されます — 食べ物の好み、仕事の習慣、ツールの好みといった事実が、ユーザー介入なしで最近のチャットから蒸留されます。メモリファイルは常にエージェントのコンテキストに読み込まれ、Claude が応答をパーソナライズできるようにします。

## モノレポパッケージ

共有コードは `packages/` 配下の公開可能な npm パッケージに抽出されています:

| パッケージ                  | 説明                                           | リンク                                                                                                  |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@mulmobridge/protocol`     | 共有型と定数                                   | [npm](https://www.npmjs.com/package/@mulmobridge/protocol) / [source](packages/protocol/)               |
| `@mulmobridge/client`       | Socket.io クライアントライブラリ               | [npm](https://www.npmjs.com/package/@mulmobridge/client) / [source](packages/client/)                   |
| `@mulmobridge/chat-service` | サーバーサイドチャットサービス (DI ファクトリ) | [npm](https://www.npmjs.com/package/@mulmobridge/chat-service) / [source](packages/chat-service/)       |
| `@mulmobridge/cli`          | ターミナルブリッジ                             | [npm](https://www.npmjs.com/package/@mulmobridge/cli) / [source](packages/bridges/cli/)                 |
| `@mulmobridge/telegram`     | Telegram ボットブリッジ                        | [npm](https://www.npmjs.com/package/@mulmobridge/telegram) / [source](packages/bridges/telegram/)       |
| `@mulmobridge/slack`        | Slack ボットブリッジ                           | [npm](https://www.npmjs.com/package/@mulmobridge/slack) / [source](packages/bridges/slack/)             |
| `@mulmobridge/discord`      | Discord ボットブリッジ                         | [npm](https://www.npmjs.com/package/@mulmobridge/discord) / [source](packages/bridges/discord/)         |
| `@mulmobridge/line`         | LINE ボットブリッジ                            | [npm](https://www.npmjs.com/package/@mulmobridge/line) / [source](packages/bridges/line/)               |
| `@mulmobridge/whatsapp`     | WhatsApp ブリッジ                              | [npm](https://www.npmjs.com/package/@mulmobridge/whatsapp) / [source](packages/bridges/whatsapp/)       |
| `@mulmobridge/matrix`       | Matrix ブリッジ                                | [npm](https://www.npmjs.com/package/@mulmobridge/matrix) / [source](packages/bridges/matrix/)           |
| `@mulmobridge/irc`          | IRC ブリッジ                                   | [npm](https://www.npmjs.com/package/@mulmobridge/irc) / [source](packages/bridges/irc/)                 |
| `@mulmobridge/mattermost`   | Mattermost ブリッジ                            | [npm](https://www.npmjs.com/package/@mulmobridge/mattermost) / [source](packages/bridges/mattermost/)   |
| `@mulmobridge/zulip`        | Zulip ブリッジ                                 | [npm](https://www.npmjs.com/package/@mulmobridge/zulip) / [source](packages/bridges/zulip/)             |
| `@mulmobridge/messenger`    | Facebook Messenger ブリッジ                    | [npm](https://www.npmjs.com/package/@mulmobridge/messenger) / [source](packages/bridges/messenger/)     |
| `@mulmobridge/google-chat`  | Google Chat ブリッジ                           | [npm](https://www.npmjs.com/package/@mulmobridge/google-chat) / [source](packages/bridges/google-chat/) |
| `@mulmobridge/mastodon`     | Mastodon ブリッジ                              | [npm](https://www.npmjs.com/package/@mulmobridge/mastodon) / [source](packages/bridges/mastodon/)       |
| `@mulmobridge/bluesky`      | Bluesky ブリッジ                               | [npm](https://www.npmjs.com/package/@mulmobridge/bluesky) / [source](packages/bridges/bluesky/)         |
| `@mulmobridge/chatwork`     | Chatwork ブリッジ (日本のビジネスチャット)     | [npm](https://www.npmjs.com/package/@mulmobridge/chatwork) / [source](packages/bridges/chatwork/)       |
| `@mulmobridge/xmpp`         | XMPP / Jabber ブリッジ                         | [npm](https://www.npmjs.com/package/@mulmobridge/xmpp) / [source](packages/bridges/xmpp/)               |
| `@mulmobridge/rocketchat`   | Rocket.Chat ブリッジ                           | [npm](https://www.npmjs.com/package/@mulmobridge/rocketchat) / [source](packages/bridges/rocketchat/)   |
| `@mulmobridge/signal`       | Signal ブリッジ (signal-cli-rest-api 経由)     | [npm](https://www.npmjs.com/package/@mulmobridge/signal) / [source](packages/bridges/signal/)           |
| `@mulmobridge/teams`        | Microsoft Teams ブリッジ (Bot Framework)       | [npm](https://www.npmjs.com/package/@mulmobridge/teams) / [source](packages/bridges/teams/)             |
| `@mulmobridge/line-works`   | LINE Works ブリッジ (エンタープライズ LINE)    | [npm](https://www.npmjs.com/package/@mulmobridge/line-works) / [source](packages/bridges/line-works/)   |
| `@mulmobridge/nostr`        | Nostr 暗号化 DM ブリッジ                       | [npm](https://www.npmjs.com/package/@mulmobridge/nostr) / [source](packages/bridges/nostr/)             |
| `@mulmobridge/viber`        | Viber ブリッジ                                 | [npm](https://www.npmjs.com/package/@mulmobridge/viber) / [source](packages/bridges/viber/)             |
| `@mulmobridge/webhook`      | 汎用 HTTP Webhook ブリッジ (開発者向けの糊)    | [npm](https://www.npmjs.com/package/@mulmobridge/webhook) / [source](packages/bridges/webhook/)         |
| `@mulmobridge/twilio-sms`   | Twilio 経由の SMS                              | [npm](https://www.npmjs.com/package/@mulmobridge/twilio-sms) / [source](packages/bridges/twilio-sms/)   |
| `@mulmobridge/email`        | Email ブリッジ (IMAP + SMTP)                   | [npm](https://www.npmjs.com/package/@mulmobridge/email) / [source](packages/bridges/email/)             |
| `@mulmobridge/mock-server`  | テスト用モックサーバー                         | [npm](https://www.npmjs.com/package/@mulmobridge/mock-server) / [source](packages/mock-server/)         |
| `@receptron/task-scheduler` | 永続化タスクスケジューラ                       | [npm](https://www.npmjs.com/package/@receptron/task-scheduler) / [source](packages/scheduler/)          |

ブリッジは任意の言語で誰でも書けます — [`docs/bridge-protocol.md`](docs/bridge-protocol.md) に記載された socket.io プロトコルを話すだけです。

## ドキュメント

完全なドキュメントは [`docs/`](docs/README.md) にあります。主なエントリポイントは次のとおりです:

### ユーザー向け

| ガイド                                                                                                     | 説明                                                                     |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [日本語](docs/mulmobridge-guide.md) / [MulmoBridge Guide](docs/mulmobridge-guide.en.md)                    | メッセージングアプリ (Telegram、Slack、LINE など) を自宅の PC に接続する |
| [日本語](docs/scheduler-guide.md) / [Scheduler Guide](docs/scheduler-guide.en.md)                          | 定期実行される自動タスク                                                 |
| [日本語](docs/tips/obsidian.md) / [Obsidian Integration](docs/tips/obsidian.en.md)                         | Obsidian を使って MulmoClaude の Wiki とドキュメントを閲覧する           |
| [日本語](docs/message_apps/telegram/README.ja.md) / [Telegram Setup](docs/message_apps/telegram/README.md) | Telegram Bot の手順別セットアップ                                        |
| [日本語](docs/message_apps/line/README.ja.md) / [LINE Setup](docs/message_apps/line/README.md)             | LINE Bot の手順別セットアップ                                            |

### 開発者向け

| ガイド                                             | 説明                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| [Developer Guide](docs/developer.md)               | 環境変数、スクリプト、ワークスペース構造、CI                      |
| [Bridge Protocol](docs/bridge-protocol.md)         | 新しいメッセージングブリッジを書くためのワイヤーレベル仕様        |
| [Sandbox Credentials](docs/sandbox-credentials.md) | Docker サンドボックスの資格情報フォワーディング (SSH、GitHub CLI) |
| [Logging](docs/logging.md)                         | ログレベル、フォーマット、ファイルローテーション                  |
| [Troubleshooting](docs/troubleshooting.md)         | セットアップの問題 — UI が崩れる、`dist/*` の 404、Windows/OneDrive、再起動後の `401`、起動時の警告 |
| [CHANGELOG](docs/CHANGELOG.md)                     | リリース履歴                                                      |

## ライセンス

MIT — [LICENSE](LICENSE) を参照してください。
