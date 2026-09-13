# MulmoClaude

[![npm version](https://img.shields.io/npm/v/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![npm downloads](https://img.shields.io/npm/dm/mulmoclaude.svg)](https://www.npmjs.com/package/mulmoclaude)
[![License: MIT](https://img.shields.io/npm/l/mulmoclaude.svg)](LICENSE)
[![CI](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml/badge.svg)](https://github.com/receptron/mulmoclaude/actions/workflows/pull_request.yaml)
[![GitHub stars](https://img.shields.io/github/stars/receptron/mulmoclaude.svg?style=social)](https://github.com/receptron/mulmoclaude/stargazers)

[English](README.md) · [日本語](README.ja.md) · **简体中文** · [한국어](README.ko.md) · [Español](README.es.md) · [Português (BR)](README.pt-BR.md) · [Français](README.fr.md) · [Deutsch](README.de.md)

**一个了解你的一切、全天候陪伴在你身边的 AI 助手，在任何地方都买不到。你无法购买 —— 只能亲手培育。MulmoClaude 就是在你自己的电脑上培育专属 AI 助手的工具。**

助手的实体并不是 AI 模型 —— 模型只是引擎。决定助手价值的，是它对你了解多少：你的对话、日程、笔记、数据，以及你使用的应用。如此重要的东西，不应托付给任何单一的服务提供商 —— 用得越久，就越难离开。MulmoClaude 是开源的，并在本地运行，因此助手积累的一切 —— 记忆、数据、应用 —— 都以普通文件的形式留在你自己的工作区中，掌握在你自己手里。

培育需要环境，而 MulmoClaude 提供了这样一个环境：一个积累记忆的地方（由 Claude 自己构建和维护的个人 wiki）、一个存放数据的地方（模式驱动的集合、订阅源、普通文件），以及一个为你打造专属应用的地方 —— 无需任何编程知识。你只要用日常语言说"我想要这样的东西"，Claude 就会构建你需要的小应用：餐厅清单、发票跟踪器、单词练习 —— 都是只为一个人而写的软件。刚安装完时，这片园地还是空的；你播下种子、耕耘土壤，培育出只属于你的助手。

而且，助手并不被绑在书桌前。从手机 —— 或你已经在用的消息应用 —— 登录，就能连上住在你电脑里的同一个助手。中继服务器只承载传输中的消息 —— 你的记忆、数据和应用永远不会离开你的电脑。

在底层，MulmoClaude 是一个 AI 原生应用平台：各项能力是单一注册表中的插件（目前包括：带真正服务端记账逻辑的完整会计系统、个人 wiki、SEC 文件阅读器等），Claude 作为通用控制器在这些插件之间进行组合编排，聊天会为每个任务召唤合适的 GUI —— markdown、图表、表单、wiki、电子表格或 3D 场景。

> **[How AI-Native Applications Should Be Built](MANIFEST.md)** —— MulmoClaude 背后的架构、UX 与协议论述。

## 📣 更新资讯

新版本与新功能会在 X 上以**日语**发布。

- [Singularity Society (@SingularitySoci)](https://x.com/SingularitySoci) —— 发布与新功能通知
- [中岛聪 (@snakajima)](https://x.com/snakajima) —— MulmoClaude 的所有者

## 快速开始

```bash
npx mulmoclaude@latest
```

启动器会启动服务器并在浏览器中打开 [http://localhost:3001](http://localhost:3001)。就这么简单 —— 开始聊天吧。

> **保持后台运行**：关闭终端会停止服务器。如需后台运行，请在 `tmux` / `screen` (macOS/Linux) 中启动，或在 Windows 上注册为任务计划程序的启动任务。

### 前置条件

- **Node.js 22.19+** —— 运行时
- **[Claude Code CLI](https://claude.ai/code)** —— 已安装并完成认证。请先运行一次 `claude` 完成 OAuth
- **ffmpeg** —— 视频生成所需。如果不生成视频可以跳过
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg`
  - Windows: `winget install Gyan.FFmpeg`
- **Docker Desktop** (可选，但推荐) —— 启用沙盒模式。参见下方 [安装 Docker Desktop](#安装-docker-desktop)

> **界面语言**：支持英语、日语、简体中文、韩语、西班牙语、葡萄牙语 (巴西)、法语、德语共 8 种语言。默认从浏览器 / 操作系统的语言设置自动检测。如需显式指定，请在 `.env` 中设置 `VITE_LOCALE=zh`。语言会在构建 / 开发期确定；修改后请重启 `yarn dev`。关于如何添加字符串，请参考 [`docs/developer.md`](docs/developer.md#i18n-vue-i18n)。

### 从源码运行 (面向开发者)

如果你想修改代码而不只是运行：

```bash
git clone git@github.com:receptron/mulmoclaude.git
cd mulmoclaude && yarn install
cp .env.example .env   # 可选 —— 添加 GEMINI_API_KEY 以启用图像生成
yarn dev
```

打开 [http://localhost:5173](http://localhost:5173)。架构和脚本细节请参见 [`docs/developer.md`](docs/developer.md)。

> **界面显示错乱或没有样式？** 图标显示为文字、`dist/*` 返回 404、重启后出现 `401` — 请参见 [`docs/troubleshooting.md`](docs/troubleshooting.md)。

## 你可以做什么？

| 让 Claude 做...      | 你将得到                                 |
| -------------------- | ---------------------------------------- |
| "写一份项目提案"     | canvas 中的富文本 markdown 文档          |
| "绘制上季度营收图表" | 交互式 ECharts 可视化                    |
| "创建京都旅行计划"   | 带图片的图文指南                         |
| "管理我的待办事项"   | 支持拖放的看板                           |
| "抓取这篇文章：URL"  | 带 `[[链接]]` 的 wiki 页面，用作长期记忆 |
| "安排每日新闻摘要"   | 自动运行的周期性任务                     |
| "生成一张日落的图片" | AI 生成的图片 (Gemini)                   |
| "订阅这个 RSS 源"    | 在 `/feeds` 注册为数据源并按计划抓取     |
| "我的源有什么新内容?" | `/feeds` 中汇集的数据源条目             |

> **可直接访问的页面**: `/wiki`（浏览 + Lint）、`/feeds`（数据源）、`/collections`（数据应用）、`/automations`（周期任务）、`/files`、`/skills`、`/roles`。每个页面都有自带页面上下文的聊天编辑器，可启动新会话。

> **参与 MulmoClaude 开发？** 请参考 [`docs/developer.md`](docs/developer.md) 了解环境变量、脚本和架构。

<a id="messaging-bridges"></a>
### 消息应用桥接

MulmoClaude 可以通过 **桥接进程** 从消息应用访问。桥接作为独立的子进程运行，并通过 socket.io 连接到服务器。

```bash
# Interactive CLI bridge (same machine)
yarn cli

# Telegram bot bridge (requires TELEGRAM_BOT_TOKEN in .env)
yarn telegram
```

桥接也以独立的 npm 包形式提供：

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

所有桥接都支持 **实时文本流式传输**（代理输入时即时更新）。CLI 和 Telegram 还支持 **文件附件**（图片、PDF、DOCX、XLSX、PPTX）。完整平台列表和设置说明请参考 [`docs/mulmobridge-guide.md`](docs/mulmobridge-guide.md)。

### 为什么需要 Gemini API 密钥？

MulmoClaude 使用 Google 的 **Gemini 3.1 Flash Image (nano banana 2)** 模型进行图片生成和编辑。它为以下功能提供支持：

- `generateImage` —— 根据文本描述创建图片
- `editImage` —— 转换或修改现有图片（例如"转换为 Ghibli 风格"）
- 文档中嵌入的内联图片（菜谱指南、旅行规划等）

如果没有 Gemini API 密钥，使用图片生成的角色将在 UI 中被禁用。

### 获取 Gemini API 密钥

1. 前往 [Google AI Studio](https://aistudio.google.com/apikey)
2. 使用你的 Google 账户登录
3. 点击 **Create API key**
4. 复制密钥并粘贴到你的 `.env` 文件，格式为 `GEMINI_API_KEY=...`

Gemini API 提供的免费额度足以满足个人使用。

<a id="security"></a>
## 安全性

MulmoClaude 使用 Claude Code 作为 AI 后端，它可以访问包括 Bash 在内的工具 —— 这意味着它可以读写你机器上的文件。

**在没有 Docker 的情况下**，Claude 可以访问你的用户账户能够访问的任何文件，包括工作区之外存储的 SSH 密钥和凭据。这对于个人本地使用是可以接受的，但值得了解。

**在安装了 Docker Desktop 的情况下**，MulmoClaude 会自动在沙盒容器内运行 Claude。只有你的工作区和 Claude 自己的配置（`~/.claude`）会被挂载 —— 文件系统的其余部分对 Claude 是不可见的。无需任何配置：应用会在启动时检测 Docker 并自动启用沙盒。

**Bearer token 认证**：每个 `/api/*` 端点都需要 `Authorization: Bearer <token>` 头部。token 在服务器启动时自动生成，并通过 `<meta>` 标签注入浏览器 —— 无需手动设置。唯一的例外是 `/api/files/*`（因为渲染文档中的 `<img>` 标签无法附加头部，所以被豁免）。详情请参考 [`docs/developer.md`](docs/developer.md#auth-bearer-token-on-api)。

**沙盒凭据转发**（需主动开启）：默认情况下，沙盒无法访问宿主机的凭据。两个环境变量可以让你有选择性地暴露 `git` / `gh` 所需的内容：

- `SANDBOX_SSH_AGENT_FORWARD=1` —— 转发宿主机的 SSH agent socket。私钥保留在宿主机上。
- `SANDBOX_MOUNT_CONFIGS=gh,gitconfig` —— 以只读方式挂载 `~/.config/gh` 和 `~/.gitconfig`。

完整契约和安全说明：[`docs/sandbox-credentials.md`](docs/sandbox-credentials.md)。

### 安装 Docker Desktop

1. 从 [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/) 下载 Docker Desktop
2. **macOS**：打开 `.dmg` 并将 Docker 拖入应用程序，然后从应用程序启动它
3. **Windows**：运行安装程序并按照提示操作（如需要，WSL2 会自动设置）
4. **Linux**：按照 [Linux 安装指南](https://docs.docker.com/desktop/install/linux/) 操作
5. 等待 Docker Desktop 启动完成 —— 菜单栏 / 系统托盘中的鲸鱼图标应变为稳定状态（而不是动画）
6. 重启 MulmoClaude —— 它会检测到 Docker 并在首次运行时构建沙盒镜像（一次性，大约需要一分钟）

当 Docker 沙盒在 macOS 上处于活动状态时，凭据会被自动管理 —— 应用会在启动时从系统 Keychain 中提取 OAuth token，并在遇到 401 错误时刷新它们，因此无需任何手动步骤。

如果没有安装 Docker，应用会显示警告横幅，并在无沙盒的情况下继续工作。

> **调试模式**：即使已安装 Docker，若想在没有沙盒的情况下运行，请在启动服务器之前设置 `DISABLE_SANDBOX=1`，或传入 CLI 标志 `--disable-sandbox`（`yarn dev --disable-sandbox` / `npx mulmoclaude --disable-sandbox`，Windows PowerShell 同样可用）。
>
> **工具调用历史**：设置 `PERSIST_TOOL_CALLS=1` 后,`tool_call` 事件(包含 `args`)将与 `tool_result` 一起被记录到会话 jsonl。默认关闭,因为 `args` 可能很大,并可能携带你不希望写入磁盘的负载字节(图像 base64、MulmoScript JSON);适合在页面刷新或服务器重启后进行调试。详见 [issue #1096](https://github.com/receptron/mulmoclaude/issues/1096)。

## 日志

服务器会将可读文本写入控制台，并将全保真 JSON 写入 `server/system/logs/` 下按天轮替的文件。所有内容都可以通过 `LOG_LEVEL`、`LOG_*_FORMAT`、`LOG_FILE_DIR` 等进行配置。

完整参考、格式示例、轮替行为和配方请参考 [docs/logging.md](docs/logging.md)。

## 角色

每个角色为 Claude 提供不同的人格、工具集和专注领域：

| 角色                | 功能                                               |
| ------------------- | -------------------------------------------------- |
| **General**         | 全能助手 —— 待办事项、调度器、wiki、文档、思维导图 |
| **Office**          | 文档、电子表格、表单、演示文稿、数据仪表盘         |
| **Guide & Planner** | 旅行指南、菜谱书、富可视化输出的旅行规划           |
| **Artist**          | 图片生成、图片编辑、使用 p5.js 的生成艺术          |
| **Tutor**           | 自适应教学 —— 在解释任何内容之前先评估你的水平     |
| **Storyteller**     | 带图片和 HTML 场景的交互式图文故事                 |

切换角色会重置 Claude 的上下文，并只加载该角色需要的工具 —— 保持响应快速而专注。

## Skills —— 从 MulmoClaude 运行你的 Claude Code 技能

MulmoClaude 可以列出并启动你已有的 **Claude Code skills**。一个 skill 是 `~/.claude/skills/<name>/` 下的任意文件夹，其中包含一个 `SKILL.md` 文件，该文件具有 YAML frontmatter 中的 `description` 以及 markdown 格式的指令正文。关于如何编写 skill 的详细信息，请参考 [Claude Code Skills 文档](https://docs.claude.com/en/docs/claude-code/skills)。

### 如何使用

1. 打开 MulmoClaude，并保持在启用 skill 的角色之一：**General**、**Office** 或 **Tutor**。
2. 让 Claude 显示你的 skill —— 例如 _"show my skills"_ 或 _"list skills"_。
3. Claude 会调用 `manageSkills` 工具，canvas 中会打开一个分栏的 **Skills** 视图：
   - **左侧**：机器上发现的每个 skill，及其描述和范围标记（`USER` / `PROJECT`）。
   - **右侧**：所选 skill 的完整 `SKILL.md` 内容。
4. 点击某个 skill 上的 **Run**。MulmoClaude 会将 `/<skill-name>` 作为普通聊天消息发送给 Claude；Claude Code 的斜杠命令机制会在 `~/.claude/skills/` 下解析它，并在同一聊天会话中内联执行该 skill 的指令。

无需额外输入、无需复制粘贴 SKILL.md 的内容 —— Run 按钮就是对 `/skill-name` 的一键封装。

### Skill 发现 —— 两种范围

| 范围        | 位置                                   | 语义                                                                             |
| ----------- | -------------------------------------- | -------------------------------------------------------------------------------- |
| **User**    | `~/.claude/skills/<name>/SKILL.md`     | 个人 skill，在你通过 Claude CLI 打开的每个项目之间共享。                         |
| **Project** | `~/mulmoclaude/.claude/skills/<name>/` | MulmoClaude 工作区范围的 skill。当名称与 user 范围冲突时，**project 范围胜出**。 |

两种范围在第 0 阶段都是只读的 —— 编辑发生在文件系统上。未来的版本将允许 MulmoClaude 本身创建 / 编辑 project 范围的 skill。

### Docker 沙盒模式 vs 非 Docker 模式

MulmoClaude 的默认 **Docker 沙盒模式** 将 Claude Code 隔离在容器中以确保安全（见 [安全性](#security)）。两种模式下 skill 的行为有所不同：

| 模式                                | User skills (`~/.claude/skills/`) | Project skills (`~/mulmoclaude/.claude/skills/`) | 内置 CLI skills (`/simplify`、`/update-config` …) |
| ----------------------------------- | --------------------------------- | ------------------------------------------------ | ------------------------------------------------- |
| **非 Docker** (`DISABLE_SANDBOX=1`) | ✅ 全部可用                       | ✅                                               | ✅                                                |
| **Docker 沙盒**（默认）             | ⚠️ 见下方注意事项                 | ✅ 通过 workspace 卷挂载                         | ✅                                                |

**Docker 注意事项 —— 为什么 user skills 有时在沙盒中不工作：**

- **符号链接的 `~/.claude/skills/`** —— 如果你的 `~/.claude/skills`（或任何子条目）是指向 `~/.claude/` 之外的符号链接（例如 `~/.claude/skills → ~/ss/dotfiles/claude/skills`），那么符号链接的目标在容器中不存在。该链接会表现为 **悬空链接**，Claude Code 会回退到只使用内置 skill。
- **沙盒镜像中较旧的 Claude CLI** —— `Dockerfile.sandbox` 在镜像构建时固定了 CLI 版本。如果该版本落后于你宿主机上的 CLI（例如镜像中的 2.1.96 vs 宿主机上的 2.1.105），user-skill 发现行为可能会有所不同。

**对于与沙盒不太兼容的 skill 丰富设置，可以采用以下变通方案：**

1. **为本次会话禁用沙盒**：

   ```bash
   # env-var form (any shell supporting VAR=value)
   DISABLE_SANDBOX=1 yarn dev

   # or the equivalent --disable-sandbox CLI flag (Windows PowerShell / npx / IDE run configs)
   yarn dev --disable-sandbox
   npx mulmoclaude --disable-sandbox
   ```

   Claude CLI 会使用你真正的 `~/.claude/` 运行，所有内容都能原生解析。只有当你信任即将发送的提示时才使用此方式 —— 对于不信任 / 探索性的工作，仍然推荐沙盒作为默认方式。

2. **将 skill 移入 project 范围** —— 将你想要的特定 skill 复制到 `~/mulmoclaude/.claude/skills/`（此路径在沙盒内作为 workspace 卷挂载，因此没有符号链接的麻烦）。对于本就是为你的 MulmoClaude 工作流专属的 skill 来说是理想方案。

3. **展平符号链接** —— 如果你通过符号链接（例如在 dotfiles 仓库中）维护你的 skill 库，将顶层 `~/.claude/skills` 符号链接替换为真实目录是最简单的解决办法。

### skill 实际接收到的内容

当你按下 **Run** 时，MulmoClaude 会发送一个包含斜杠命令字符串的普通 user turn：

```text
/my-skill-name
```

这就是全部 payload —— MulmoClaude **不会** 内联 `SKILL.md` 正文或额外上下文。正文是 Claude Code 在 CLI 端解析斜杠命令时读取的内容。这样可以保持聊天输入简洁，使长 skill（多 KB 的 `SKILL.md`）可以安全运行而不会撑爆 prompt 上下文。

### 将对话保存为新 skill

在一次富有成效的聊天之后，你可以让 MulmoClaude 捕获该工作流：

```text
"この会話を fix-ci という skill にして"
"save this as a skill called publish-flow"
"skill 化して"   ← Claude picks a slug for you
```

Claude 会读取当前聊天记录，提炼出你执行的步骤，并将一个新的 `SKILL.md` 写入 `~/mulmoclaude/.claude/skills/<slug>/`。该 skill 会立即出现在 Skills 视图中，并可在未来任何会话中通过 `/<slug>` 调用。

保存的注意事项：

- **仅限 project 范围** —— 保存位置为 `~/mulmoclaude/.claude/skills/`，永远不会保存到 `~/.claude/skills/`。user 范围在 MulmoClaude 中保持只读。
- **不会覆盖** —— 如果同名 skill 已存在（在任一范围中），保存会失败，Claude 会要求你提供一个不同的名字。
- **slug 规则** —— 小写字母、数字和连字符；1–64 个字符；不允许前导 / 尾随或连续的连字符。Claude 会自动选择一个；如果你想用特定的名称，请在请求中说明。

### 删除已保存的 skill

Project 范围的 skill 在 Skills 视图中的 Run 按钮旁边会有一个 **Delete** 按钮（user 范围的 skill 是只读的 —— 不会显示 Delete 按钮）。确认对话框后会删除 `~/mulmoclaude/.claude/skills/<slug>/SKILL.md`。如果你在该文件夹中还手动放入了额外文件，那些文件会保持原样；只有 SKILL.md 会被删除。

你也可以让 Claude 按名称删除：

```text
"delete the fix-ci skill"
```

## Wiki —— Claude Code 的长期记忆

MulmoClaude 包含一个 **个人知识库**，其灵感来自 [Andrej Karpathy 的 LLM Knowledge Bases 想法](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)。它为 Claude Code 提供了真正的长期记忆 —— 不只是一个短短的 `memory.md`，而是一个由 Claude 自己构建并维护的、不断扩展的互联 wiki。

**General** 角色内置了 wiki 支持。试一试：

- `"Ingest this article: <URL>"` —— Claude 抓取页面，提取关键知识，创建或更新 wiki 页面并记录活动
- `"What does my wiki say about transformers?"` —— Claude 搜索索引，阅读相关页面，并综合出一个有根据的答案
- `"Lint my wiki"` —— 对孤立页面、失效链接和缺失的索引条目进行健康检查
- `"Show me the wiki index"` —— 在 canvas 中渲染完整的页面目录

### 工作原理

wiki 完全作为工作区中的纯 markdown 文件存在：

```
<workspace>/data/wiki/
  index.md          ← catalog of all pages (title, description, last updated)
  log.md            ← append-only activity log
  pages/<slug>.md   ← one page per entity, concept, or theme
  sources/<slug>.md ← raw ingested sources
```

Claude 使用其内置的文件工具（`read`、`write`、`glob`、`grep`）来导航和维护 wiki —— 无需特殊的数据库或索引。交叉引用使用 `[[wiki link]]` 语法，canvas UI 会将其渲染为可点击的导航。

随着时间推移，wiki 会成长为一个任何角色都可以查阅的个人知识库，让 Claude 随着你的使用而变得越来越有用。

## 图表 (ECharts)

`presentChart` 插件在 canvas 中渲染 [Apache ECharts](https://echarts.apache.org/) 可视化。你可以要求折线图、柱状图、K 线图、sankey 图、热力图或网络 / 图结构 —— Claude 编写 ECharts option 对象，插件负责挂载它。每个图表都有一个 **[↓ PNG]** 按钮，可一键导出。

可在 **General**、**Office**、**Guide & Planner** 和 **Tutor** 角色中使用。试一试：

```text
Chart last quarter's revenue by region as a bar chart
Plot AAPL's daily closes for the last 30 days as a candlestick
Show a sankey of energy flow: coal/gas/solar → electricity → home/industry/transport
```

### 存储

每次调用 `presentChart` 都会在 `<workspace>/artifacts/charts/` 下写入一个文件：

```text
<workspace>/artifacts/charts/
  sales-overview-1776135210389.chart.json
  apple-stock-1776135300000.chart.json
```

单个文档可以容纳任意数量的图表，它们会在 canvas 中垂直堆叠渲染：

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

`option` 字段会原样传递给 ECharts 的 [`setOption`](https://echarts.apache.org/en/api.html#echartsInstance.setOption) —— 在手动编辑这些文件时，你可以参考完整的 [ECharts option 参考](https://echarts.apache.org/en/option.html)。下次在 canvas 中重新打开文档时，编辑会生效。

## 可选：X (Twitter) MCP 工具

MulmoClaude 包含可选的 MCP 工具，通过官方 X API v2 读取和搜索 X (Twitter) 上的帖子。

| 工具        | 功能                            |
| ----------- | ------------------------------- |
| `readXPost` | 通过 URL 或推文 ID 获取单条帖子 |
| `searchX`   | 按关键词或查询搜索最近的帖子    |

这些工具 **默认禁用**，需要 X API Bearer Token 才能激活。

### 设置

1. 前往 [console.x.com](https://console.x.com) 并使用你的 X 账户登录
2. 创建一个新应用 —— 会自动生成 Bearer Token
3. 复制 Bearer Token 并添加到你的 `.env`：
   ```
   X_BEARER_TOKEN=your_bearer_token_here
   ```
4. 在 [console.x.com](https://console.x.com) 为你的账户充值（调用 API 需要）
5. 重启开发服务器 —— 工具会自动激活

### 用法

这些工具 **仅在自定义角色中可用**。内置角色默认不包含它们（General 除外）。要在你自己的角色中使用它们：

1. 在 `~/mulmoclaude/roles/<id>.json` 下创建或编辑自定义角色的 JSON 文件
2. 将 `readXPost` 和 / 或 `searchX` 加入其 `availablePlugins` 列表

配置完成后，你可以将任意 `x.com` 或 `twitter.com` URL 粘贴到聊天中，Claude 会自动获取并阅读。

## 配置附加工具（Web 设置）

侧边栏中的齿轮图标会打开设置模态框，你可以在其中扩展 Claude 的工具集而无需编辑代码。更改在下一条消息时生效（无需重启服务器）。

### Allowed Tools 标签

每行粘贴一个工具名。这对 Claude Code 的内置 MCP 服务器（Gmail、Google Calendar）在一次性 OAuth 握手之后很有用：

```text
mcp__claude_ai_Gmail
mcp__claude_ai_Google_Calendar
```

首先，在终端中运行一次 `claude mcp` 并为每项服务完成 OAuth 流程 —— 凭据会持久化在 `~/.claude/` 下。

### MCP Servers 标签

无需手动编辑 JSON 即可添加外部 MCP 服务器。支持两种类型：

- **HTTP** —— 远程服务器（例如 `https://example.com/mcp`）。在所有模式下都可用；在 Docker 中，`localhost` / `127.0.0.1` URL 会自动被改写为 `host.docker.internal`。
- **Stdio** —— 本地子进程（例如一个 `npx` MCP），出于安全考虑限制为 `npx` / `node` / `tsx`。Docker 沙盒**关闭**时在主机上运行。沙盒**开启**时，stdio 条目**默认被丢弃**（最小化的沙盒镜像无法承载任意运行时）—— 改为设置 `"hostExecInDocker": true`，即可让其在主机上通过 `stdio ↔ HTTP` 网关运行。参见 [docs/mcp-sandbox.md](docs/mcp-sandbox.md)。

用 **`env`** 映射向 stdio 服务器传递凭据（`"env": { "IMAP_PASS": "…" }`）。取值为字面量并保存在 `mcp.json` 中（模式 `0600`，但为**明文**—— 是文件权限保护，而非保险库）。完整细节，包括 `hostExecInDocker` 选项以及 `env` 如何到达进程，见 [docs/mcp-sandbox.md](docs/mcp-sandbox.md)。

配置位于 `<workspace>/config/`：

```text
<workspace>/config/
  settings.json    ← extra allowed tool names
  mcp.json         ← Claude CLI --mcp-config compatible
```

MCP 文件使用 Claude CLI 的标准格式，因此你可以在机器之间复制它，甚至可以直接在 `claude` CLI 中使用。

### 直接编辑配置文件

两个文件都是纯 JSON —— 你可以用任何文本编辑器编辑，而不是使用 Settings UI。服务器会在每条消息时重新读取它们，因此：

- 文件编辑后无需重启服务器。
- 更改也会被 Settings UI 采纳 —— 只需关闭并重新打开模态框即可。
- UI 和文件始终保持同步：从 UI 保存会覆盖文件，而手动编辑会在下次打开 UI 时显示出来。

这在以下情况下很方便：

- 从另一台工作站批量导入 MCP 服务器（复制 `mcp.json`）。
- 将你的设置版本控制在 dotfiles 仓库中。
- 通过翻转 `"enabled": false` 临时禁用某个服务器。

**`mcp.json` 示例** —— 一个远程 HTTP 服务器（公共、无认证）和一个本地 stdio 服务器：

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

服务器在加载文件时强制执行的约束：

- `mcpServers` 的键（服务器 id）必须匹配 `^[a-z][a-z0-9_-]{0,63}$`。
- HTTP 的 `url` 必须解析为 `http:` 或 `https:`。
- Stdio 的 `command` 被限制为 `npx`、`node` 或 `tsx`。
- 未通过验证的条目会在加载时被静默丢弃（会记录一条警告）；文件的其余部分仍然生效。

**示例** —— 一个带凭据、且在 Docker 沙盒下也能运行的 stdio 服务器（例如一个 IMAP MCP）：

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

`hostExecInDocker` 会让该服务器在主机上（沙盒之外）运行。这是一个按服务器的开关 —— 可按需为多个服务器启用，但只对你信任的服务器启用。沙盒关闭时该设置会被忽略（服务器本就在主机上运行）。

**`settings.json` 示例**：

```json
{
  "extraAllowedTools": ["mcp__claude_ai_Gmail", "mcp__claude_ai_Google_Calendar"]
}
```

对于在 `mcp.json` 中定义的服务器，你不需要列出 `mcp__<id>` 条目 —— 这些会在每次 agent 运行时自动被允许。`extraAllowedTools` 仅适用于那些无法通过你自己的 `mcpServers` 访问的工具，通常是 Claude Code 内置的 `mcp__claude_ai_*` 桥接，用于你已经运行过 `claude mcp` 并完成 OAuth 之后的情况。

## 聊天附件

将文件粘贴（Ctrl+V / Cmd+V）或拖放到聊天输入框中，随你的消息一起发送给 Claude。

| 文件类型                                          | Claude 看到的内容   | 依赖                         |
| ------------------------------------------------- | ------------------- | ---------------------------- |
| 图片 (PNG、JPEG、GIF、WebP …)                     | 视觉内容块（原生）  | 无                           |
| PDF                                               | 文档内容块（原生）  | 无                           |
| 文本 (.txt、.csv、.json、.md、.xml、.html、.yaml) | 解码后的 UTF-8 文本 | 无                           |
| DOCX                                              | 提取的纯文本        | `mammoth` (npm)              |
| XLSX                                              | 每个工作表一个 CSV  | `xlsx` (npm)                 |
| PPTX                                              | 转换为 PDF          | LibreOffice (Docker sandbox) |

PPTX 转换在 Docker 沙盒镜像内运行（`libreoffice --headless`）。没有 Docker 时，会提示消息建议改为导出为 PDF 或图片。最大附件大小为 30 MB。

## Canvas 视图模式

canvas（右侧面板）支持 8 种视图模式，可通过启动器工具栏、URL 查询参数或键盘快捷键切换：

| 快捷键       | 视图      | URL 参数          | 描述                       |
| ------------ | --------- | ----------------- | -------------------------- |
| `Cmd/Ctrl+1` | Single    | (默认)            | 显示所选工具结果           |
| `Cmd/Ctrl+2` | Stack     | `?view=stack`     | 所有结果垂直堆叠           |
| `Cmd/Ctrl+3` | Files     | `?view=files`     | 工作区文件浏览器           |
| `Cmd/Ctrl+5` | Scheduler | `?view=scheduler` | 定时任务日历               |
| `Cmd/Ctrl+6` | Wiki      | `?view=wiki`      | Wiki 页面索引              |
| `Cmd/Ctrl+7` | Skills    | `?view=skills`    | Skill 列表与编辑器         |
| `Cmd/Ctrl+8` | Roles     | `?view=roles`     | 角色管理                   |

每种视图模式都由 URL 驱动：点击启动器按钮会更新 `?view=`，而访问带有（例如）`?view=wiki` 的 URL 会恢复相应的视图。视图模式列表在 `src/utils/canvas/viewMode.ts` 中定义一次 —— 添加新模式只需在数组中追加一项。

## 远程访问

从手机（或任意浏览器）访问正在运行的 MulmoClaude —— 随时随地浏览它的集合、动态源和自定义视图，并发起对话。无需配置单独的账户或服务器：只要在**两端都使用同一个 Google 账户**登录，即可获得访问权限。

**如何连接**

1. 在桌面端，点击页头的 **phonelink** 图标打开_远程主机_弹出框，然后选择**使用 Google 登录**。MulmoClaude 会以你的 Google 用户身份登录，并通过 Firebase（共享的公开项目 [`mulmoserver`](https://mulmoserver.web.app)）打开一个命令通道。主机在线期间图标显示为绿色。
2. 在手机上打开 **[https://mulmoserver.web.app](https://mulmoserver.web.app)** 并使用**同一个 Google 账户**登录。Web 应用会找到你在线的主机并与之连接。

由于两端都以同一个 Firebase 用户身份进行认证，手机和桌面端只会在你自己的用户空间内相遇 —— 任何第三方都无法访问你的主机。

**Firebase 和 Firestore 仅用作传输通道** —— 用于在手机和桌面端之间转发命令与响应的中继。你的数据**绝不会存储或保留**在任何一端。主机上只存在你本地的工作区文件；任何需要经过通道的内容（例如经由 Firebase Storage 中转的附件）在到达目的地后会立即删除。

**你可以从手机上做什么**

- 浏览并翻阅你的**集合**和**动态源**。
- 打开**自定义远程视图**（custom remote view）—— 由 Claude 为你构建的适配移动端的页面。请让 Claude 构建 _custom remote view_（而不是普通的自定义视图），它可以是只读的，也可以是可写的。
- 在主机上**发起对话**，并从手机附加**照片、视频或 PDF**。附件的字节太大，无法通过命令通道传输，因此会经由 Firebase Storage 中转；主机将每个文件下载到它的工作区（`data/attachments/`），删除中转副本，然后将文件连同你的消息一起交给 Claude。

该通道基于命令且由主机驱动：手机发出请求，你的桌面端 MulmoClaude 予以响应。使用弹出框中的**断开连接**（或退出 MulmoClaude）即可让主机离线。

## 工作区

所有数据以纯文件形式存储在工作区目录中，分为四个语义桶 (#284)：

```
~/mulmoclaude/
  config/              ← settings.json, mcp.json, roles/, helps/
  conversations/       ← chat/, memory.md, summaries/, searches/
  data/                ← wiki/, todos/, calendar/, contacts/, scheduler/,
                         sources/, transports/
  artifacts/           ← charts/, documents/, html/, html-scratch/,
                         images/, news/, spreadsheets/, stories/
```

完整参考请参考 [`docs/developer.md`](docs/developer.md#workspace-layout-mulmoclaude)。

### 待办事项列表

待办事项列表现以模式驱动的 **集合（collection）** 构建，而非专用视图。让 Claude “建立一个待办事项列表”，它会按照 `config/helps/todo-collection.md` 创建一个 `todos` 集合 —— 包含状态 enum（`Backlog / Todo / In Progress / Done`）、`done` 切换以及可选的优先级 / 截止日期字段，并根据模式自动选择看板 / 表格 / 日历视图。

### 调度器与 skill 调度

调度器（`Cmd/Ctrl+5` 或 `?view=scheduler`）管理存储在 `data/scheduler/items.json` 中的周期性任务。调度器核心（`@receptron/task-scheduler`）处理错过运行的追赶逻辑，并支持 `interval`、`daily` 和 `cron` 调度。

通过在 SKILL.md frontmatter 中添加 `schedule` 字段，可以将 skill 设置为自动运行：

```yaml
---
description: Morning news digest
schedule: daily 08:00
---
```

Claude 会将该 skill 注册到调度器中，它会按照指定的调度自动运行。

### 记忆提取

Claude 会自动从聊天对话中提取持久的用户事实，并将其追加到 `conversations/memory.md`。这作为日常 journal pass 的一部分运行 —— 饮食偏好、工作习惯和工具偏好等事实会在无需用户干预的情况下从最近的聊天中提炼出来。记忆文件始终会加载到 agent 上下文中，因此 Claude 可以个性化响应。

## Monorepo 包

共享代码被抽取到 `packages/` 下可发布的 npm 包中：

| 包                          | 描述                                    | 链接                                                                                                    |
| --------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `@mulmobridge/protocol`     | 共享类型和常量                          | [npm](https://www.npmjs.com/package/@mulmobridge/protocol) / [源代码](packages/protocol/)               |
| `@mulmobridge/client`       | Socket.io 客户端库                      | [npm](https://www.npmjs.com/package/@mulmobridge/client) / [源代码](packages/client/)                   |
| `@mulmobridge/chat-service` | 服务器端聊天服务（DI 工厂）             | [npm](https://www.npmjs.com/package/@mulmobridge/chat-service) / [源代码](packages/chat-service/)       |
| `@mulmobridge/cli`          | 终端桥接                                | [npm](https://www.npmjs.com/package/@mulmobridge/cli) / [源代码](packages/bridges/cli/)                 |
| `@mulmobridge/telegram`     | Telegram bot 桥接                       | [npm](https://www.npmjs.com/package/@mulmobridge/telegram) / [源代码](packages/bridges/telegram/)       |
| `@mulmobridge/slack`        | Slack bot 桥接                          | [npm](https://www.npmjs.com/package/@mulmobridge/slack) / [源代码](packages/bridges/slack/)             |
| `@mulmobridge/discord`      | Discord bot 桥接                        | [npm](https://www.npmjs.com/package/@mulmobridge/discord) / [源代码](packages/bridges/discord/)         |
| `@mulmobridge/line`         | LINE bot 桥接                           | [npm](https://www.npmjs.com/package/@mulmobridge/line) / [源代码](packages/bridges/line/)               |
| `@mulmobridge/whatsapp`     | WhatsApp 桥接                           | [npm](https://www.npmjs.com/package/@mulmobridge/whatsapp) / [源代码](packages/bridges/whatsapp/)       |
| `@mulmobridge/matrix`       | Matrix 桥接                             | [npm](https://www.npmjs.com/package/@mulmobridge/matrix) / [源代码](packages/bridges/matrix/)           |
| `@mulmobridge/irc`          | IRC 桥接                                | [npm](https://www.npmjs.com/package/@mulmobridge/irc) / [源代码](packages/bridges/irc/)                 |
| `@mulmobridge/mattermost`   | Mattermost 桥接                         | [npm](https://www.npmjs.com/package/@mulmobridge/mattermost) / [源代码](packages/bridges/mattermost/)   |
| `@mulmobridge/zulip`        | Zulip 桥接                              | [npm](https://www.npmjs.com/package/@mulmobridge/zulip) / [源代码](packages/bridges/zulip/)             |
| `@mulmobridge/messenger`    | Facebook Messenger 桥接                 | [npm](https://www.npmjs.com/package/@mulmobridge/messenger) / [源代码](packages/bridges/messenger/)     |
| `@mulmobridge/google-chat`  | Google Chat 桥接                        | [npm](https://www.npmjs.com/package/@mulmobridge/google-chat) / [源代码](packages/bridges/google-chat/) |
| `@mulmobridge/mastodon`     | Mastodon 桥接                           | [npm](https://www.npmjs.com/package/@mulmobridge/mastodon) / [源代码](packages/bridges/mastodon/)       |
| `@mulmobridge/bluesky`      | Bluesky 桥接                            | [npm](https://www.npmjs.com/package/@mulmobridge/bluesky) / [源代码](packages/bridges/bluesky/)         |
| `@mulmobridge/chatwork`     | Chatwork 桥接（日本商务聊天）           | [npm](https://www.npmjs.com/package/@mulmobridge/chatwork) / [源代码](packages/bridges/chatwork/)       |
| `@mulmobridge/xmpp`         | XMPP / Jabber 桥接                      | [npm](https://www.npmjs.com/package/@mulmobridge/xmpp) / [源代码](packages/bridges/xmpp/)               |
| `@mulmobridge/rocketchat`   | Rocket.Chat 桥接                        | [npm](https://www.npmjs.com/package/@mulmobridge/rocketchat) / [源代码](packages/bridges/rocketchat/)   |
| `@mulmobridge/signal`       | Signal 桥接（通过 signal-cli-rest-api） | [npm](https://www.npmjs.com/package/@mulmobridge/signal) / [源代码](packages/bridges/signal/)           |
| `@mulmobridge/teams`        | Microsoft Teams 桥接（Bot Framework）   | [npm](https://www.npmjs.com/package/@mulmobridge/teams) / [源代码](packages/bridges/teams/)             |
| `@mulmobridge/line-works`   | LINE Works 桥接（企业版 LINE）          | [npm](https://www.npmjs.com/package/@mulmobridge/line-works) / [源代码](packages/bridges/line-works/)   |
| `@mulmobridge/nostr`        | Nostr 加密 DM 桥接                      | [npm](https://www.npmjs.com/package/@mulmobridge/nostr) / [源代码](packages/bridges/nostr/)             |
| `@mulmobridge/viber`        | Viber 桥接                              | [npm](https://www.npmjs.com/package/@mulmobridge/viber) / [源代码](packages/bridges/viber/)             |
| `@mulmobridge/webhook`      | 通用 HTTP webhook 桥接（开发者粘合剂）  | [npm](https://www.npmjs.com/package/@mulmobridge/webhook) / [源代码](packages/bridges/webhook/)         |
| `@mulmobridge/twilio-sms`   | 通过 Twilio 发送 SMS                    | [npm](https://www.npmjs.com/package/@mulmobridge/twilio-sms) / [源代码](packages/bridges/twilio-sms/)   |
| `@mulmobridge/email`        | Email 桥接（IMAP + SMTP）               | [npm](https://www.npmjs.com/package/@mulmobridge/email) / [源代码](packages/bridges/email/)             |
| `@mulmobridge/mock-server`  | 用于测试的 Mock 服务器                  | [npm](https://www.npmjs.com/package/@mulmobridge/mock-server) / [源代码](packages/mock-server/)         |
| `@receptron/task-scheduler` | 持久化任务调度器                        | [npm](https://www.npmjs.com/package/@receptron/task-scheduler) / [源代码](packages/scheduler/)          |

任何人都可以用任何语言编写一个桥接 —— 只需遵循 [`docs/bridge-protocol.md`](docs/bridge-protocol.md) 中记录的 socket.io 协议即可。

## 文档

完整文档位于 [`docs/`](docs/README.md)。以下是关键入口：

### 面向用户

| 指南                                                                                                      | 描述                                                    |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| [MulmoBridge 指南](docs/mulmobridge-guide.en.md) / [日本語](docs/mulmobridge-guide.md)                    | 将消息应用（Telegram、Slack、LINE 等）连接到你的家用 PC |
| [调度器指南](docs/scheduler-guide.en.md) / [日本語](docs/scheduler-guide.md)                              | 周期性自动任务                                          |
| [Obsidian 集成](docs/tips/obsidian.en.md) / [日本語](docs/tips/obsidian.md)                               | 使用 Obsidian 浏览 MulmoClaude 的 wiki 和文档           |
| [Telegram 设置](docs/message_apps/telegram/README.md) / [日本語](docs/message_apps/telegram/README.ja.md) | 分步 Telegram Bot 设置                                  |
| [LINE 设置](docs/message_apps/line/README.md) / [日本語](docs/message_apps/line/README.ja.md)             | 分步 LINE Bot 设置                                      |

### 面向开发者

| 指南                                    | 描述                                   |
| --------------------------------------- | -------------------------------------- |
| [开发者指南](docs/developer.md)         | 环境变量、脚本、工作区结构、CI         |
| [桥接协议](docs/bridge-protocol.md)     | 编写新消息桥接的线级规范               |
| [沙盒凭据](docs/sandbox-credentials.md) | Docker 沙盒凭据转发（SSH、GitHub CLI） |
| [日志](docs/logging.md)                 | 日志级别、格式、文件轮替               |
| [故障排查](docs/troubleshooting.md)     | 安装问题 — 界面错乱、`dist/*` 404、Windows/OneDrive、重启后 `401`、启动警告 |
| [CHANGELOG](docs/CHANGELOG.md)          | 发布历史                               |

## 许可证

MIT —— 参见 [LICENSE](LICENSE)。
