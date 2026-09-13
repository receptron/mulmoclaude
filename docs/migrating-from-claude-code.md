# Claude Code → MulmoClaude 移行ガイド

普段 Claude Code (CLI) を使っているユーザが MulmoClaude に移行するときの注意点と手順をまとめる。

MulmoClaude は内部で Claude Code (Claude Agent SDK) を呼び出すアプリなので、**多くの資産はそのまま使い回せる**。
ただし「ワークスペースの場所」と「設定ファイルの所在」が分かれているため、以下を意識して移行するとスムーズ。

---

## TL;DR — 何がそのまま使えて何が引っ越し必要か

| Claude Code の資産 | MulmoClaude での扱い | アクション |
|---|---|---|
| `~/.claude/skills/<name>/SKILL.md` (user skills) | **そのまま読まれる** (read-only) | 何もしなくて良い |
| `~/.claude/CLAUDE.md` (global instructions) | **読まれない** | 必要分を MulmoClaude の role / settings に移植 |
| プロジェクト `CLAUDE.md` | **読まれない** | 同上、あるいは reference dirs から参照 |
| `~/.claude/settings.json` (Claude Code 設定) | **Claude CLI 起動経路でそのまま読まれる** | アプリレベルの MulmoClaude 設定は別ファイル: `~/mulmoclaude/config/settings.json` |
| `~/.claude/.mcp.json` / プロジェクト `.mcp.json` | **読まれない** | `~/mulmoclaude/config/mcp.json` にコピー |
| Claude Code の hooks | **`<workspace>/.claude/settings.json` 経由なら有効** | MulmoClaude UI から設定する導線はないが、ファイルを直接置けば Claude CLI が読む |
| プロジェクトの `*.md` ドキュメント | **読まれない (デフォルト)** | wiki にコピー / reference dirs マウント / Obsidian 共有のいずれか (後述) |
| Claude Code の chat 履歴 | **引き継がれない** | 新しい session で開始 |

**短くまとめると**:
- skill = ✅ 移行不要
- それ以外 = △ 何らかの形で MulmoClaude のワークスペースに置き直す

---

## 1. ワークスペースの違いを理解する

Claude Code は基本的に **「現在のディレクトリ」と `~/.claude/` を見る** CLI。
MulmoClaude は **「`~/mulmoclaude/`」を中心とする独立したアプリ**。

### Claude Code の典型レイアウト

```
~/.claude/
  CLAUDE.md             ← global instructions (system prompt 注入)
  skills/               ← user skills (markdown)
  settings.json         ← Claude Code 設定
  .mcp.json             ← MCP サーバ設定 (グローバル)

<your-project>/
  CLAUDE.md             ← project instructions (system prompt 注入)
  .claude/skills/       ← project skills
  .mcp.json             ← project MCP
```

### MulmoClaude の典型レイアウト

```
~/mulmoclaude/                  ← 「ワークスペース」
  config/
    settings.json               ← MulmoClaude 設定
    mcp.json                    ← MCP サーバ設定
    roles/                      ← user-defined role (任意)
    helps/                      ← role 別 help テキスト (任意)
    workspace-dirs.json         ← user-defined カスタム dir (任意)
    reference-dirs.json         ← 外部 read-only マウント先 (任意)
  conversations/
    chat/                       ← chat session ジャーナル (.jsonl)
    memory/                     ← 長期メモリ (per-fact markdown)
    summaries/                  ← 日次サマリー
  data/
    wiki/pages/                 ← wiki page (.md)
    todos/  calendar/  contacts/  scheduler/  sources/
    plugins/<encoded-pkg>/      ← runtime plugin が書く永続データ
  artifacts/
    documents/  html/  images/  charts/  spreadsheets/  stories/  news/
  github/                       ← git clone 先
  plugins/                      ← user-installed runtime plugin

~/.claude/skills/               ← Claude Code と共有 (read-only)
~/mulmoclaude/.claude/skills/   ← MulmoClaude project scope (writable)
```

ポイント:
- **`~/mulmoclaude/` の場所は `MULMOCLAUDE_WORKSPACE_PATH` で変更できる** (`server/workspace/paths.ts` — `workspacePath`)。`~/mulmoclaude` は env 未設定時のフォールバック。モジュール読み込み時に一度だけ評価されるので、起動時に指定して再起動する
- **MulmoClaude は `~/.claude/skills/` を再利用** ([後述](#3-skill-の移行))
- それ以外の Claude Code 設定は読み込まれない

---

## 2. 移行 — 全体の手順

### Step 1: MulmoClaude を初回起動

**前提**: Node.js 22.19+ と [Claude Code CLI](https://claude.ai/code) がインストール・認証済みであること。
Claude Code を普段使っている人なら後者は満たしているはず。

選択肢は2つ。**どちらでも `~/mulmoclaude/` ワークスペースは共有**される (= 後で乗り換えても資産そのまま)。

#### A. リリース版を使う (簡単・安定)

```bash
npx mulmoclaude@latest
```

- インストール不要、最新公開版が自動で使われる
- `~/mulmoclaude/` がない場合は自動で初期化
- ブラウザが [http://localhost:5173](http://localhost:5173) で開けば OK
- 普段使いはこちらで十分

#### B. 開発版 (git clone) を使う (最新機能・実験中の新プラグイン)

新しいプラグインや機能は **main ブランチに先にマージされ、リリースは数日〜数週遅れる**。
最新を試したい / バグ報告したい / 自分でも plugin を作りたい場合は git clone する。

```bash
# 1. clone & install
git clone git@github.com:receptron/mulmoclaude.git
# (HTTPS なら) git clone https://github.com/receptron/mulmoclaude.git
cd mulmoclaude
yarn install

# 2. (任意) Gemini API key — 画像生成に必要
cp .env.example .env
# .env を開いて GEMINI_API_KEY=... を埋める

# 3. dev サーバ起動
yarn dev
```

- ブラウザは `http://localhost:5173` (client) を開く。サーバは `127.0.0.1` の解決されたポート
  (`PORT` 指定時はそのポート — 塞がっていれば先へ進まず終了する。未指定なら既定 `3001` から
  空きへ進む) で listen し、実際のポートは起動ログの
  `[server] listening port=…` と `<workspace>/.server-port` に出る
- 起動中もホットリロード — `src/` を編集すれば即反映
- `~/mulmoclaude/` ワークスペースは A と共有 (= 並行運用しないこと、後述)

##### 最新を取り込み続ける運用

```bash
cd ~/path/to/mulmoclaude
git fetch origin
git checkout main && git pull origin main
yarn install              # 依存変動があれば
yarn dev                  # 再起動
```

リリースが速いプロジェクトなので、週1〜数日に一度 `git pull` するだけで新機能 (plugin / role / MCP catalog 拡張) が降ってくる。

##### Docker sandbox を使わない場合

```bash
DISABLE_SANDBOX=1 yarn dev
```

reference dirs の `:ro` 強制 (§4.3) など一部のセキュリティ機構が外れる代わりに、Docker なしで起動できる。

##### UI 言語を固定したい場合

```bash
echo 'VITE_LOCALE=ja' >> .env    # ja / en / zh / ko / es / pt-BR / fr / de
```

ロケールはビルド時に焼き込まれるので、変更後は `yarn dev` を再起動。

#### A と B の使い分け / 切替時の注意

- **同じワークスペース (`~/mulmoclaude/`)** を共有するので、どちらで起動しても chat 履歴 / wiki / skill / 設定はそのまま見える
- **同時起動はしない** — 衝突するのはポートではなく **workspace** です。塞がっていれば
  サーバは先のポートへ進みますが、`<workspace>/.server-port` は 1 つしか無く、2 台のサーバを
  同時には書けません。2 スタック動かすなら `PORT` と `MULMOCLAUDE_WORKSPACE_PATH` を明示すること
- B (dev) では plugin の `@mulmoclaude/*` が yarn workspace の symlink で解決される (= ローカル `packages/*-plugin/src/` がそのまま動く)
- リリース版 A に戻したい時は `cd ~/path/to/mulmoclaude && (server プロセス停止)` してから `npx mulmoclaude@latest` を別ディレクトリで叩けば OK

詳しい開発フローは [`docs/developer.md`](developer.md) と [`README.md`](../README.md) を参照。

### Step 2: skill を確認 (たいてい何もしなくて良い)

`~/.claude/skills/` 配下に置いてあるユーザ skill は **そのまま MulmoClaude からも見える**。
画面右上の「Skills」(または `/skills`) で一覧を確認。

### Step 3: MCP サーバ設定を引き継ぐ (使っていれば)

`~/.claude/.mcp.json` に MCP サーバ定義があれば、`~/mulmoclaude/config/mcp.json` にコピー。

```bash
mkdir -p ~/mulmoclaude/config
cp ~/.claude/.mcp.json ~/mulmoclaude/config/mcp.json
```

形式は同じなので変換不要。再起動で反映される。

詳細は [`docs/extension-mechanisms.md`](extension-mechanisms.md) の §3.4 (External MCP server)。

### Step 4: ドキュメント / wiki の移行 (使っていれば)

[§4 wiki / 既存ドキュメント移行](#4-wiki--既存ドキュメント移行) を参照。

### Step 5: CLAUDE.md の指示を MulmoClaude 流に書き直す (任意)

[§5 CLAUDE.md の扱い](#5-claudemd-の扱い) を参照。

### Step 6: Role を選ぶ / 必要なら作る

MulmoClaude は session 開始時に **role (ペルソナ)** を選ぶ仕組み。
Claude Code には role の概念がないので、ここが一番違う。

組み込み role: `general`, `office`, `guide`, `artist`, `tutor`, `storyteller`, `accounting`, `cookingCoach`, ...
カスタム role は Settings → Roles から作成可能 (`manageRoles` プラグイン)。

詳細は [`docs/extension-mechanisms.md`](extension-mechanisms.md) の §3.6 (Role)。

---

## 3. Skill の移行

**結論**: 移行作業はほぼ不要。

### 3.1 共有される場所

MulmoClaude は **Claude Code と同じ `~/.claude/skills/` を読む** (`server/workspace/skills/paths.ts:18-19`)。

```ts
// server/workspace/skills/paths.ts
export const USER_SKILLS_DIR = join(homedir(), ".claude", "skills");
```

つまり `~/.claude/skills/foo/SKILL.md` を Claude Code で書いたなら、MulmoClaude からもそのまま `foo` skill として見える。

### 3.2 二段スコープ

MulmoClaude の skill は2つのスコープを持ち、後者が前者を上書きする:

| スコープ | パス | MulmoClaude での扱い |
|---|---|---|
| **user** | `~/.claude/skills/<name>/SKILL.md` | **read-only** — MulmoClaude UI から編集不可 |
| **project** | `~/mulmoclaude/.claude/skills/<name>/SKILL.md` | **writable** — `manageSkills` プラグインで CRUD |

同じ名前の skill が両方にある場合、**project が勝つ** (`server/workspace/skills/discovery.ts:109`)。

### 3.3 Frontmatter の互換性

MulmoClaude が認識する frontmatter は Claude Code と同じ:

```yaml
---
name: weekly-summary
description: 毎週金曜に今週の wiki 編集をまとめる
schedule: "interval 168h"          # MulmoClaude 固有: scheduler で自動実行
---
```

**MulmoClaude 固有**: `schedule:` フィールドを書くと内蔵 scheduler が指定間隔で skill を自動起動する (`server/api/routes/scheduler.ts`)。Claude Code には scheduler はないので、ここを書いても Claude Code 側では無視される (= 互換)。

### 3.4 移行手順 (まとめ)

1. **何もしない** — `~/.claude/skills/` の skill はそのまま使える
2. **編集したい** skill が user scope にあるなら、**MulmoClaude の project scope にコピー**して編集する:
   ```bash
   mkdir -p ~/mulmoclaude/.claude/skills/myskill
   cp ~/.claude/skills/myskill/SKILL.md ~/mulmoclaude/.claude/skills/myskill/
   ```
3. **自動実行したい**なら frontmatter に `schedule:` を追加 (interval / daily 形式)

---

## 4. Wiki / 既存ドキュメント移行

これが移行の **一番の悩みどころ**。MulmoClaude は「ワークスペース内のファイルが第一級の状態」という設計なので、
Claude Code 時代のドキュメント資産をどう取り込むかで利便性が変わる。

選択肢は3つ。**用途で使い分ける**。

### 4.1 戦略 A: wiki ディレクトリにコピーする (推奨・参照頻度高)

**いつ**: 普段から AI に参照・更新させたい知識ベース、メモ、議事録、調査ノートなど。

**手順**:

```bash
mkdir -p ~/mulmoclaude/data/wiki/pages
# プロジェクトのドキュメントを wiki にコピー
cp -r ~/projects/my-project/docs/*.md ~/mulmoclaude/data/wiki/pages/
```

**注意点**:
- ファイル名はそのまま slug になる (例: `architecture.md` → wiki page `architecture`)
- スラッグ規則は `lowercase-hyphen-separated` 推奨 (`server/workspace/wiki-pages/io.ts`)
- `[[wiki link]]` 構文がそのまま機能する (cross-reference)
- 既存の frontmatter (title, tags, created, updated) は維持される

**MulmoClaude 側の取り扱い**:
- 一覧: `data/wiki/index.md`
- ログ: `data/wiki/log.md`
- 履歴 (#763): 編集ごとに `data/wiki/.history/<slug>/` に snapshot

### 4.2 戦略 B: Obsidian Vault と兼用する (推奨・モバイル / 並行編集したい)

**いつ**: 既に Obsidian で管理しているドキュメント、または iPhone / iPad からも見たいもの。

`~/mulmoclaude/` を Obsidian Vault として開けば、`data/wiki/pages/` の中身がそのまま Obsidian のグラフ・検索・タグ機能で扱える。コード変更不要・Obsidian プラグイン不要。

詳細手順: [`docs/tips/obsidian.md`](tips/obsidian.md)

### 4.3 戦略 C: reference dirs として外部からマウントする (read-only)

**いつ**: ドキュメントは元の場所に置いたまま AI に参照だけさせたい (= Claude Code が `cd <project>` で読めていた感覚を残したい)。

**手順**:

1. Settings → Reference dirs を開く (または `~/mulmoclaude/config/reference-dirs.json` を直接編集):

```json
[
  { "hostPath": "/Users/isamu/projects/my-project", "label": "My Project" },
  { "hostPath": "/Users/isamu/Documents/notes", "label": "Notes" }
]
```

2. MulmoClaude を再起動

**特徴**:
- Docker mode では **ファイルシステム強制 read-only マウント** (`:ro`) (`server/workspace/reference-dirs.ts:1-7`)
- 非 Docker mode ではプロンプト指示ベースの read-only (緩い)
- AI は内容を読めるが書き込めない
- 機密ディレクトリ (`.ssh`, `.aws`, `/etc` 等) は自動でブロック
- **Docker mode ではコンテナ内のパスが変わる** — `/mnt/readonly/<basename>-<hash8>` にマウントされ、ホストの絶対パスはコンテナ内に存在しない (`server/workspace/reference-dirs.ts` — `containerPath`)。システムプロンプトにはラベルとマウント先の対応表が入るので、**チャットやカスタム role の `prompt` では絶対パスではなくラベルで指す**こと。ホストパスを直書きすると Docker mode では何も読めず、しかもエラーが出ない

**最大エントリ数**: 20 (`server/workspace/reference-dirs.ts` — `MAX_ENTRIES`)

### 4.4 どれを選ぶか

| 条件 | 推奨 |
|---|---|
| AI に書き換えてほしい / 蓄積させたい | **A (wiki にコピー)** |
| Obsidian / iPhone でも見たい | **B (Obsidian 兼用)** |
| 元のディレクトリのまま動かしたくない | **C (reference dirs)** |
| プロジェクトコードを AI に読ませたい | **C** (`~/projects/foo` をマウント) |

混在も可能。Wiki は永続知識、reference dirs は「今このプロジェクトで作業」用、と分けると整理しやすい。

---

## 5. CLAUDE.md の扱い

**MulmoClaude は `~/.claude/CLAUDE.md` もプロジェクト `CLAUDE.md` も自動では読まない**。
理由: MulmoClaude は **role-based persona** で system prompt を組み立てる構造で、生の `CLAUDE.md` 注入は仕組み上の対応外 (`server/agent/prompt.ts:683` の `buildSystemPrompt` 参照)。

### 移植先の選び方

`CLAUDE.md` に書いてあった内容のタイプ別に:

| 内容 | MulmoClaude での移植先 |
|---|---|
| 言語設定 / 口調 / 一般的な指示 | UI 言語は `VITE_LOCALE` で明示固定可、未設定時は `navigator.languages` / `navigator.language` (= ブラウザ / OS) から自動判定 (`src/lib/vue-i18n.ts` `detectLocale`)、最終フォールバック `en` ; 口調 / 一般的な指示は role の `prompt` に書く (manageRoles) |
| プロジェクト固有の文脈 / コーディング規約 | **新しい role** を作る (`manageRoles`) — その role の `prompt` に書く |
| 「特定のファイルを参照」「特定ディレクトリを read」 | **reference dirs** (§4.3) で物理的にマウント |
| 「このコマンドを使え」「このツールは使うな」 | role の `availablePlugins` でプラグインを絞る |
| Skill 的な手順 | **skill に変換** (§3) |

### Claude Code が CLAUDE.md でやっていた system prompt 拡張は MulmoClaude にはない

MulmoClaude の system prompt は `server/agent/prompt.ts:683` の `buildSystemPrompt` で組み立てられる:

- ベース ⊕ role.prompt ⊕ 各 plugin の prompt セクション ⊕ skill 一覧 ⊕ memory 抜粋 ⊕ workspace 概要

ユーザが直接編集する経路は提供されていない (= role / skill / memory / settings の経由でのみ介入可能)。

---

## 6. Settings / hooks / chat 履歴

### 6.1 Settings

**MulmoClaude 自身の設定**は Claude Code とは別ファイルに置く:

- Claude Code: `~/.claude/settings.json` (theme, model, hooks 等) — **MulmoClaude 起動時もそのまま Claude CLI が読む**
- MulmoClaude: `~/mulmoclaude/config/settings.json` (`AppSettings` 型 — `server/system/config.ts`) — 現状フィールドは **`extraAllowedTools` のみ** (Allowed Tools の追記分)。MCP servers / 参照ディレクトリといった残りのアプリ設定は `~/mulmoclaude/config/` 配下の別ファイル群 (`mcp.json`、`workspace-dirs.json` など) に分かれている。

両方が並列で効く。MulmoClaude の **Settings モーダル** (サイドバー上部の歯車アイコン → `<SettingsModal>` を開く ; URL 直アクセスのルートは無い) からは Allowed Tools / MCP servers / 参照ディレクトリを編集できる (それぞれ別の保存先)。
**Gemini API key は `.env` で管理** — Settings モーダルの Gemini タブは「`.env` に `GEMINI_API_KEY` を追加して再起動」という案内 + Ask ボタンのみで、UI 上での入力・保存はできない。
Claude Code 側 (model 選択、`apiKeyHelper` 等) は `~/.claude/settings.json` を直接編集する従来通りのフロー。

### 6.2 Hooks

**MulmoClaude UI から hook を設定する導線はない**が、Claude Code の hook 機構そのものは生きている:

- `~/.claude/settings.json` の `hooks.PostToolUse` / `PreToolUse` などは Claude CLI が起動時に読み、そのまま発火する
- `~/mulmoclaude/.claude/settings.json` (workspace scope) も同様 — 実際 wiki-history 機能はここに `PostToolUse` hook を auto-provision している (`server/workspace/wiki-history/provision.ts`)
- 既存の hook を移植したいなら、ファイルをそのままコピー / パス書き換えで OK

UI 操作で使いたい場合は **scheduler + skill** で代用するのも手 (frontmatter に `schedule:` を書く)。

### 6.3 Chat 履歴

**移行されない**。
- Claude Code: `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
- MulmoClaude: `~/mulmoclaude/conversations/chat/<sessionId>.jsonl` (新規)

ただし MulmoClaude は内部で Claude Code を `--resume <sessionId>` で起動するので、**MulmoClaude の同じ session を継続**することは可能 (`server/agent/config.ts:249-250`)。
別アプリ間で履歴を共有する経路はない。

---

## 7. よくあるハマりどころ

### 7.1 「MCP サーバが認識されない」

→ **`mcp.json` の場所**。`~/.claude/.mcp.json` ではなく `~/mulmoclaude/config/mcp.json`。
ファイルがない場合は MCP なしで起動する (= デフォルト挙動)。

### 7.2 「Claude Code で書いた skill が呼ばれない」

→ skill の **`description`** をきちんと書く。Claude Code SDK は skill の description を見て使い場面を判断するので、空 / 曖昧だと選ばれにくい。frontmatter の `name:` と `description:` を必須項目として書く。

### 7.3 「プロジェクトの CLAUDE.md が無視される」

→ §5 を参照。設計上の仕様。**reference dirs マウント** + AI への明示的指示 (「`@my-project/CLAUDE.md` を参照して」) で代用するのが実務的。

### 7.4 「サンドボックス警告で機能が動かない」

→ Docker が起動していない可能性。`docker info` で確認。
sandbox なしで動かすなら `DISABLE_SANDBOX=1 npx mulmoclaude`。
ただし MCP の reference dirs `:ro` 強制は失われる。

### 7.5 「~/mulmoclaude を別の場所に置きたい」

→ `MULMOCLAUDE_WORKSPACE_PATH` で指定する (`server/workspace/paths.ts` — `workspacePath`)。`~/mulmoclaude` は env 未設定時のフォールバック:

```bash
mv ~/mulmoclaude /Volumes/External/mulmoclaude
MULMOCLAUDE_WORKSPACE_PATH=/Volumes/External/mulmoclaude npx mulmoclaude
```

モジュール読み込み時に一度だけ評価されるので、**起動前**に設定する。動作中のサーバーを切り替える API / UI / CLI フラグは無い。指定先が存在しなければ起動時に作られる (`git init` も含む)。

### 7.6 「Claude Code の sub-agent (Agent tool) は使える?」

→ **使える**。MulmoClaude は内部で Claude Code を呼んでいるので、Claude Code の sub-agent / Task ツールはそのまま機能する。

---

## 8. 関連ドキュメント

- [`docs/extension-mechanisms.md`](extension-mechanisms.md) — 7つの拡張機構の全体像
- [`docs/developer.md`](developer.md) — アーキ全体
- [`docs/tips/obsidian.md`](tips/obsidian.md) — Obsidian 連携 (戦略 B 詳細)
- [`docs/memory.md`](memory.md) — メモリの仕組み (Claude Code の `~/.claude/projects/.../memory*` とは別物)
- [`docs/sandbox-credentials.md`](sandbox-credentials.md) — Docker sandbox での認証情報まわり

---

## チェックリスト

移行後に動作確認しておくと安心なポイント:

- [ ] `~/.claude/skills/` の skill が MulmoClaude の Skills 一覧に出ている
- [ ] よく使う MCP サーバが `~/mulmoclaude/config/mcp.json` にコピーされ、再起動後に MCP catalog 画面で接続済み表示される
- [ ] 必要なドキュメントが §4 のいずれかの戦略で AI から見えている
- [ ] 普段使う role を 1 つ決めた / カスタム role が必要なら作った
- [ ] Docker sandbox が動いている (`docker info` 成功)
- [ ] reference dirs マウントが反映されている (chat で「参照ディレクトリ **My Project** の `README.md` を見せて」のように **ラベルで** 確認。ホストの絶対パスで頼むと Docker mode では読めない → [§4.3](#43-戦略-c-reference-dirs-として外部からマウントする-read-only))
