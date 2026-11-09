# MulmoClaude を AWS Bedrock 経由の Anthropic Claude で動かす

## 概要

MulmoClaude のエージェントは Claude Code CLI (`claude` コマンド) を経由して Anthropic Claude を呼んでいます。Claude Code CLI 自体が **AWS Bedrock 経由のモデル呼び出しを公式サポート**しているので、MulmoClaude のコードを変更せず **環境変数だけ**で Bedrock 上の Claude に切替えられます。

このガイドはエンタープライズ環境（オンプレ / 顧客 AWS アカウント / マルチテナント SaaS）で MulmoClaude をデプロイし、`~/.claude` ホストログインを使わずに Bedrock の IAM 認証で動かすための手順です。

> 💡 個人利用で `claude login` 経由でログインしている方は、このガイドは不要です。デフォルトの Anthropic 直 API がそのまま動きます。

---

## 前提条件

- AWS アカウント（Bedrock が有効化されているリージョン）
- Bedrock コンソールで **Anthropic モデルへのアクセスが許可済み**
- Node.js 24.15 以降 / 26 以降
- Docker（推奨。MulmoClaude のサンドボックスを使う場合）
- AWS 認証情報を取得できる方法（IAM ロール / IAM ユーザのアクセスキー / SSO）

---

## ステップ 1: AWS Bedrock 側の準備

### 1.1 モデルアクセスの有効化

1. AWS マネジメントコンソールで Bedrock を開く
2. リージョンを選ぶ（例: `us-east-1`、`us-west-2`、`ap-northeast-1` など — 利用したいモデルが提供されているリージョン）
3. 左メニューから **Model access** を開く
4. 利用したい Anthropic モデル（Claude Sonnet / Opus / Haiku）の access を **request** → **granted** にする

### 1.2 IAM ポリシー

MulmoClaude を動かす実行主体（IAM ユーザ / IAM ロール）に最低限以下のポリシーを付与:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream"
      ],
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/anthropic.*",
        "arn:aws:bedrock:*:*:inference-profile/*anthropic.*"
      ]
    }
  ]
}
```

`Resource` を絞り込みたい場合は、利用するモデル ID とリージョンを明示してください。

### 1.3 認証情報の渡し方

優先順位（推奨順）:

1. **IAM ロール（EC2 / ECS / EKS / Lambda 上で動かす場合）** — 環境変数不要、AWS SDK が自動取得
2. **環境変数** — `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`（一時クレデンシャル）
3. **`~/.aws/credentials` ファイル** — ローカル開発時のみ
4. **AWS SSO + CLI プロファイル** — `AWS_PROFILE` 環境変数で指定

⚠️ ハードコード／コミットされたアクセスキーは絶対に使わないこと。

---

## ステップ 2: MulmoClaude 側の設定

### 2.1 環境変数

MulmoClaude のリポジトリルートに `.env` を作成（または起動環境に export）:

```bash
# Bedrock モードを有効化（必須）
export CLAUDE_CODE_USE_BEDROCK=1

# Bedrock のリージョン（必須）
export AWS_REGION=us-east-1

# 利用するモデル（必須 — モデル ID は次節を参照）
export ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0

# 認証情報（IAM ロールを使う場合は不要）
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
# 一時クレデンシャル（STS）の場合
export AWS_SESSION_TOKEN=...

# Bedrock では Anthropic 専用 beta header が動かない場合がある
# 動作不安定なときに有効化
# export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
```

### 2.2 モデル ID の指定

Bedrock のモデル ID は **Anthropic 直 API の名前と異なる**ので注意。

- **直 API**: `claude-sonnet-4-6`
- **Bedrock**: `us.anthropic.claude-sonnet-4-5-20250929-v1:0`（クロスリージョン推論プロファイル）

正確な ID は AWS 公式 [Anthropic Claude models — Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-claude.html) を参照してください。リージョン・バージョンによって変わります。

> 💡 Bedrock では多くの場合 **inference profile（`us.` プレフィクス）が必要** です。素のモデル ID（`anthropic.claude-...`）はオンデマンドで叩けないことがあります。

---

## ステップ 3: 起動と動作確認

```bash
# 開発モードで起動
npm run dev
```

ブラウザで `http://localhost:5173` を開き、簡単な質問を送って応答が返ってくれば OK。

### 動作確認のチェックポイント

- 起動ログに Bedrock 関連の警告が出ていないこと
- AWS CloudTrail で `bedrock:InvokeModel` の呼び出しが記録されていること
- `claude --version` が利用可能なこと（MulmoClaude が内部で叩いている）

### CLI 単体での切り分けテスト

問題が出た場合は、MulmoClaude 経由ではなく Claude Code CLI 単体で動作確認するのが速いです:

```bash
CLAUDE_CODE_USE_BEDROCK=1 \
AWS_REGION=us-east-1 \
ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
claude "Hello"
```

これで応答が返れば、MulmoClaude 側の設定問題に絞り込めます。

---

## ステップ 4: 高度な認証パターン（オプション）

### 4.1 `apiKeyHelper` で動的トークン取得

JWT や Vault からトークンを動的に取得したい場合、Claude Code の settings に `apiKeyHelper` を設定できます:

```json
// ~/.claude/settings.json または プロジェクト .claude/settings.json
{
  "apiKeyHelper": "/path/to/get-bedrock-token.sh"
}
```

```bash
# get-bedrock-token.sh
#!/bin/bash
aws sts get-session-token --query 'Credentials.SessionToken' --output text
```

更新間隔:
```bash
export CLAUDE_CODE_API_KEY_HELPER_TTL_MS=3600000  # 1時間
```

### 4.2 LiteLLM / claude-code-router を sidecar として挟む

監査ログ・コスト追跡・ロードバランス・複数顧客向けマルチプロバイダ routing が必要なら、Bedrock の手前にゲートウェイを置く構成も可能です:

```
MulmoClaude
   ↓ ANTHROPIC_BASE_URL=http://gateway:4000
[gateway: claude-code-router (Node) または LiteLLM (Python)]
   ↓
AWS Bedrock
```

詳細は issue #813 のコメントを参照。

---

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| `AccessDeniedException` | Bedrock コンソールでモデルアクセスが未承認、または IAM ポリシー不足 |
| `ValidationException: model identifier...` | `ANTHROPIC_MODEL` の ID が間違い、またはリージョンに存在しない |
| `ThrottlingException` | リージョンのクォータ不足 → AWS サポートに緩和申請 |
| `Could not connect to Bedrock` | `AWS_REGION` 未設定 または ネットワーク問題 |
| 応答が返ってくるが tool calling が壊れる | `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` を試す |
| `~/.claude` のログインが優先されてしまう | `unset ANTHROPIC_API_KEY` および `~/.claude/credentials.json` を一時的にリネーム |

---

## 運用上の注意

### コスト

- Bedrock の従量課金は Anthropic 直 API と料金体系が異なる（同一モデルでも単価差あり）
- クロスリージョン推論 (`us.` プレフィクス) は通常リージョン単独より若干高い場合あり
- AWS Cost Explorer で Bedrock の利用を tag-based で分けて追跡することを推奨

### リージョン

- 利用したいモデルが目的のリージョンで提供されているか必ず確認
- 日本リージョン (`ap-northeast-1`) は Anthropic モデル提供が遅れることがある
- マルチテナント SaaS でテナントごとにリージョンを分けるなら env をテナント単位で切替える設計が必要

### 機能差

- Anthropic 専用 beta（一部の最新機能）は Bedrock 経由だと無効になることがある
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` でフォールバック
- MulmoClaude の skills / hooks / sandbox / MCP / Stop ボタン (#731) は Bedrock 経由でも全て動く（client-side 機能のため）

### マルチテナント分離

MulmoClaude の Docker サンドボックスはテナントごとに container を分けて起動する形で再利用できます:

- テナント `acme` → container `mulmoclaude-acme` + `~/mulmoclaude-acme` ワークスペース
- 各 container に異なる `.env` を渡してテナント別の IAM ロール / Bedrock リージョンに振る

---

## 参考リンク

- [Claude Code 公式: LLM gateway configuration](https://code.claude.com/docs/en/llm-gateway)
- [AWS Bedrock: Anthropic Claude models](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-claude.html)
- [AWS Bedrock: Inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)
- [MulmoClaude: backend 抽象化議論 (issue #813)](https://github.com/receptron/mulmoclaude/issues/813)
- [English version](./bedrock-deployment.en.md)
