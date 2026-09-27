---
title: What is a collection?
layout: default
parent: English
nav_order: 2
description: A collection is your own small app made of a blueprint (schema.json) and records (one file each). How it works and where the files live.
---

# What is a collection?
{: .no_toc }

<details open markdown="block">
<summary>On this page</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

## In one sentence

**A collection is a small app of your own that Claude builds for you.**

Say *"I want to keep track of restaurants — name, cuisine, whether I've been, and a rating"* and
Claude builds a table with exactly those fields. What you get:

- A **table** you can sort and search
- A **calendar**, if there is a date
- A **kanban board** (cards you drag between columns), if there is a choice like "To do / Doing / Done"
- **Reminders**, such as "notify me while it's unfinished" or "10 days before the due date"
- **Buttons** such as "Create invoice" that make Claude do the work
- **Custom views** — screens with a look you design yourself

And after it exists, you can say *"add a notes field"* or *"only let me rate after I've visited"* and
it changes on the spot. We call this **vibe crafting**: building your tools by talking.

## Inside: a blueprint and records

A collection is just two things:

| | What | Example |
|---|---|---|
| **Blueprint** | `schema.json` — which fields exist and how to show them | "Name is text, rating is 1–5" |
| **Records** | One file per record (`<id>.json`) | `ramen-taro.json` holds one restaurant |

There is no database. **The folder and its files are the app.** So you can open the data as ordinary
files, back it up, or hand it to someone.

Curious about the blueprint? See [How schema.json works](schema.md). You do not need it to create
or use a collection.

## Where are the files?

Inside your workspace (normally `~/mulmoclaude`):

```text
~/mulmoclaude/
├── data/
│   ├── skills/
│   │   └── restaurants/          ← the collection itself (blueprint, etc.)
│   │       ├── SKILL.md          ← instructions for Claude
│   │       ├── schema.json       ← the blueprint
│   │       ├── views/            ← custom views (if any)
│   │       └── templates/        ← what a button asks Claude to do (if any)
│   └── restaurants/
│       └── items/                ← records, one file each
│           ├── ramen-taro.json
│           └── sushi-hana.json
└── .claude/skills/restaurants/   ← a copy MulmoClaude makes automatically
```

{: .note }
`.claude/skills/` holds a copy MulmoClaude maintains for you. Do not edit it by hand.
To change the blueprint, asking Claude is the most reliable way.

The collection's folder name (e.g. `restaurants`) is its **slug**. It is also its address:
`http://localhost:3001/collections/restaurants`.

## How does Claude know how to build one?

At startup MulmoClaude places a how-to for collections in your workspace's `config/helps/`, and Claude
reads it before writing a blueprint. Every blueprint is checked before it is saved, so a broken one
is very unlikely to end up on disk.

---

Next: [Create a collection](create.md).
