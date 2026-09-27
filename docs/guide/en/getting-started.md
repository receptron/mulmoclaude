---
title: Getting started
layout: default
parent: English
nav_order: 1
description: What MulmoClaude needs (Node.js and Claude Code), how to launch it, and how to start it from an icon.
---

# Getting started
{: .no_toc }

<details open markdown="block">
<summary>On this page</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

## What you need

| Requirement | What it is for | Required? |
|---|---|---|
| **Node.js 22.19 or later** | Runs MulmoClaude | Yes |
| **Claude Code** | MulmoClaude's brain — must be installed and signed in | Yes |
| Docker Desktop | Runs Claude's work inside a safe box (the sandbox) | Optional (recommended) |
| ffmpeg | Only for making videos | Optional |

### Install Node.js

Download the **LTS** version from [nodejs.org](https://nodejs.org/) and install it.
To check, open a terminal ("Terminal" on macOS, "PowerShell" on Windows) and run:

```bash
node -v
```

Anything `v22.19.0` or higher is fine.

### Install Claude Code and sign in

Install it by following [the Claude Code page](https://claude.ai/code), then run this once in a terminal:

```bash
claude
```

and follow the prompts to sign in. You can close the terminal afterwards.

{: .note }
MulmoClaude runs on your Claude Code sign-in. You do not need a separate API key.

## Launch

Run this one line in a terminal:

```bash
npx mulmoclaude@latest
```

After a moment your browser opens [http://localhost:3001](http://localhost:3001) with MulmoClaude in it.
You are ready.

{: .warning }
**Closing the terminal stops MulmoClaude.** Keep it open while you use the app.

### Start it from an icon (macOS / Windows)

If opening a terminal every time is a chore, run this once:

```bash
npx mulmoclaude@latest create-shortcut
```

On macOS this puts `MulmoClaude.app` in Applications; on Windows it adds a Start Menu shortcut.
From then on, double-click to start. If something is missing, it tells you what to install.

## Display language

The language follows your browser or OS setting.

## Where is my data?

Everything MulmoClaude makes is stored as ordinary files in the **`~/mulmoclaude`** folder in your
home directory. We call it the **workspace**. Nothing is uploaded to the cloud behind your back.

---

Next: [What is a collection?](what-is-a-collection.md) — or jump straight to [Create a collection](create.md).
