# feat(#2923): 設定でチャットのモデルを選べるようにする

## 背景

MulmoClaude は `claude` CLI を `--model` なしで spawn するため、使用モデルは常に
`~/.claude/settings.json` の `model` から解決される。このファイルは VS Code / Cursor の
Claude Code 拡張が `/model` ピッカーの選択を保存する先でもあるので、**別クライアントで
モデルを切り替えると MulmoClaude のモデルまで一緒に変わる**。UI に表示が無いため気づけない。

実機確認: このマシンの `~/.claude/settings.json` に `"model": "opus[1m]"` が入っており、
MulmoClaude の全セッションがこれを継承している。

実害は価格帯だけではない。#2923 のコメントでは、guide ロールでの旅程作成1件
（ツール呼び出し 906 回 / サブエージェント 16 体 / 入力 98.9M トークン）で 8 分で
5 時間枠に到達し、以後 5 時間 Claude Code 全体が使えなくなった例が報告されている。

## 方針

`AppSettings` に `chatModel` を足し、設定されているときだけ `buildCliArgs` が
`--model <alias>` を1本積む。**未設定は現状どおりフラグ省略**（共有ファイルに追従）なので
既定の挙動は変わらない。既存の `effortLevel`（#1323）と同じ経路・同じ null センチネル
方式に載せるため、新しい仕組みは持ち込まない。

### 受け付ける値

ファミリーエイリアス `opus` / `sonnet` / `haiku` のみ。`claude-opus-4-8` のような固定 ID は
弾く（保存した選択が新しい世代へ自動追随してほしいため）。CLI 2.1.269 の `--model` は
エイリアスを受け付ける（`claude --help` で確認）。リポジトリ内の既存 3 箇所
（`archivist-cli.ts` / `chat-index/summarizer.ts` / `translation/llm.ts`）も同じ形。

`fable` は今回入れない — issue の提案が 3 つだったのに合わせる。増やすのは
`CHAT_MODELS` への1行追加で済む。

## 変更するファイル

| ファイル | 変更 |
|---|---|
| `server/system/config.ts` | `CHAT_MODELS` / `ChatModel` / `AppSettings.chatModel`、`isChatModel`、`APP_SETTINGS_KEYS` / `SAFE_SETTINGS_KEYS`、patch の null センチネル、`cloneAppSettings`、`saveSettings` |
| `server/api/routes/config.ts` | null センチネルでの `delete merged.chatModel` |
| `server/agent/backend/types.ts` | `AgentInput.chatModel` |
| `server/agent/index.ts` | `chatModel: settings.chatModel` |
| `server/agent/backend/claude-code.ts` | `cliArgsForInput` の pass-through |
| `server/agent/config.ts` | `CliArgsParams.chatModel` → `args.push("--model", chatModel)` |
| `src/components/SettingsModelTab.vue` | 既存 Model タブに select を1つ追加 |
| `src/lang/*.ts`（8言語） | `settingsModal.modelTab` にキー追加 |
| `packages/core/assets/helps/bug-report-faq.md` | 「想定と違うモデルで動く」項目（`configKey: chatModel`） |
| テスト4本 | `test_config.ts` / `test_configRoute.ts` / `test_agent_config.ts` / `test_cliArgsForInput.ts` |

## スコープ外

- ロール単位のモデル指定（#3104）。ロールオブジェクトは `roleForm.ts:formToRole` /
  `RolesView.vue` / `manageRoles/definition.ts` の3箇所でフィールド単位に再構築されるため、
  ロール JSON にキーを足すだけだと **UI で編集した瞬間に黙って消える**。ロール編集 UI まで
  含めた別 PR にする。
- 使用中モデルの画面表示（#2554 の後半）。
- セッション途中のモデル切替（`/model` 相当）。

## 確認事項

- `--model` は `--resume` と併用される（MulmoClaude は初回以外 `--resume` を付ける）。
  `--effort` が既に同じ経路を通っているため前例どおりだが、実機で会話2ターン目以降も
  指定モデルで動くことを確認する。
- `opus[1m]` のようなサフィックス付き指定を使っているユーザーは、このタブで `opus` を
  選ぶとサフィックスが落ちる（明示的に選ぶという趣旨どおりだが、体感差は出る）。
