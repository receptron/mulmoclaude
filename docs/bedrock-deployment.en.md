# Running MulmoClaude on AWS Bedrock (Anthropic Claude)

## Overview

MulmoClaude's agent talks to Anthropic Claude through the Claude Code CLI (`claude` command). The Claude Code CLI itself **officially supports invoking models through AWS Bedrock**, so MulmoClaude can run against Bedrock Claude with **environment variables only** — no code changes required.

This guide covers deploying MulmoClaude in enterprise environments (on-prem, customer AWS accounts, multi-tenant SaaS) and authenticating via Bedrock IAM instead of `~/.claude` host login.

> 💡 If you use MulmoClaude personally with `claude login`, this guide is not needed. The default direct Anthropic API works out of the box.

---

## Prerequisites

- AWS account in a region where Bedrock is available
- **Anthropic model access granted** in the Bedrock console
- Node.js 24.15+ / 26+
- Docker (recommended, if you want MulmoClaude's sandbox)
- A way to obtain AWS credentials (IAM role / IAM user access keys / SSO)

---

## Step 1: Prepare AWS Bedrock

### 1.1 Enable model access

1. Open Bedrock in the AWS Management Console
2. Pick a region (e.g. `us-east-1`, `us-west-2`, `ap-northeast-1` — wherever the model you need is offered)
3. Go to **Model access** in the left sidebar
4. Request and approve access to the Anthropic models you want (Claude Sonnet / Opus / Haiku)

### 1.2 IAM policy

Attach at least the following policy to the IAM principal (user or role) that will run MulmoClaude:

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

Tighten the `Resource` list to specific model IDs and regions if you want to scope it down.

### 1.3 Where credentials come from

Recommended order:

1. **IAM role** (preferred when running on EC2 / ECS / EKS / Lambda) — the AWS SDK picks it up automatically, no env vars needed
2. **Environment variables** — `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` (for STS temporary credentials)
3. **`~/.aws/credentials` file** — local development only
4. **AWS SSO + CLI profile** — set `AWS_PROFILE`

⚠️ Never hard-code or commit access keys.

---

## Step 2: Configure MulmoClaude

### 2.1 Environment variables

Create a `.env` at the repo root (or export before launch):

```bash
# Enable Bedrock mode (required)
export CLAUDE_CODE_USE_BEDROCK=1

# Bedrock region (required)
export AWS_REGION=us-east-1

# Model to use (required — see next section for IDs)
export ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0

# Credentials (omit when using an IAM role)
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
# For temporary (STS) credentials
export AWS_SESSION_TOKEN=...

# Some Anthropic-only beta headers don't pass through Bedrock.
# Enable this if you see weird tool-calling failures.
# export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1
```

### 2.2 Model IDs

Bedrock model IDs **differ from the direct Anthropic API names** — be careful.

- **Direct API**: `claude-sonnet-4-6`
- **Bedrock**: `us.anthropic.claude-sonnet-4-5-20250929-v1:0` (cross-region inference profile)

For exact, current IDs check the AWS official [Anthropic Claude models on Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-claude.html). They depend on region and model version.

> 💡 In Bedrock you usually need an **inference profile (`us.` prefix)** — the bare `anthropic.claude-...` model ID often doesn't accept on-demand traffic.

---

## Step 3: Launch and verify

```bash
# Start in dev mode
npm run dev
```

Open `http://localhost:5173`, ask a simple question, and confirm a reply comes back.

### What to check

- No Bedrock-related warnings in the startup log
- AWS CloudTrail shows `bedrock:InvokeModel` calls
- `claude --version` works (MulmoClaude shells out to it internally)

### Isolating issues with the CLI alone

If something doesn't work, test with the Claude Code CLI directly first — it's the fastest way to narrow down:

```bash
CLAUDE_CODE_USE_BEDROCK=1 \
AWS_REGION=us-east-1 \
ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0 \
claude "Hello"
```

If that returns a response, the issue is on the MulmoClaude side; if not, it's AWS / IAM / model-access.

---

## Step 4: Advanced auth patterns (optional)

### 4.1 `apiKeyHelper` for dynamic tokens

If you fetch tokens from Vault or generate JWTs dynamically, configure Claude Code's `apiKeyHelper`:

```json
// ~/.claude/settings.json or project .claude/settings.json
{
  "apiKeyHelper": "/path/to/get-bedrock-token.sh"
}
```

```bash
# get-bedrock-token.sh
#!/bin/bash
aws sts get-session-token --query 'Credentials.SessionToken' --output text
```

Refresh interval:
```bash
export CLAUDE_CODE_API_KEY_HELPER_TTL_MS=3600000  # 1 hour
```

### 4.2 Putting LiteLLM / claude-code-router in front

If you need audit logging, cost tracking, load balancing, or multi-provider routing across multiple customers, you can put a gateway in front of Bedrock:

```
MulmoClaude
   ↓ ANTHROPIC_BASE_URL=http://gateway:4000
[gateway: claude-code-router (Node) or LiteLLM (Python)]
   ↓
AWS Bedrock
```

See issue #813 comments for details.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `AccessDeniedException` | Model access not yet granted in Bedrock console, or IAM policy too narrow |
| `ValidationException: model identifier...` | `ANTHROPIC_MODEL` is wrong or the model isn't available in this region |
| `ThrottlingException` | Region quota too low — file a support ticket to raise it |
| `Could not connect to Bedrock` | `AWS_REGION` not set, or network can't reach the Bedrock endpoint |
| Replies come back but tool calling breaks | Try `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` |
| `~/.claude` login keeps overriding | `unset ANTHROPIC_API_KEY` and temporarily rename `~/.claude/credentials.json` |

---

## Operational notes

### Cost

- Bedrock pay-as-you-go pricing differs from the direct Anthropic API (same model, different unit cost)
- Cross-region inference (the `us.` prefix) is sometimes slightly more expensive than single-region invocations
- Track Bedrock spend by tag in AWS Cost Explorer

### Region

- Confirm your model is offered in your target region before committing
- The Tokyo region (`ap-northeast-1`) often gets Anthropic models late
- For multi-tenant SaaS where tenants need different regions, design env-per-tenant

### Feature gaps

- Some Anthropic-only betas (cutting-edge features) are unavailable through Bedrock
- Use `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` as a fallback
- MulmoClaude's skills / hooks / sandbox / MCP / Stop button (#731) all keep working through Bedrock — they are client-side concerns

### Multi-tenant isolation

MulmoClaude's Docker sandbox is reusable for tenant-per-container deployments:

- Tenant `acme` → container `mulmoclaude-acme` + `~/mulmoclaude-acme` workspace
- Each container takes its own `.env` for tenant-specific IAM role / Bedrock region

---

## References

- [Claude Code: LLM gateway configuration](https://code.claude.com/docs/en/llm-gateway)
- [AWS Bedrock: Anthropic Claude models](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-claude.html)
- [AWS Bedrock: Inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html)
- [MulmoClaude: backend abstraction discussion (issue #813)](https://github.com/receptron/mulmoclaude/issues/813)
- [日本語版](./bedrock-deployment.md)
