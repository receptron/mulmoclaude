---
title: Troubleshooting
layout: default
parent: English
nav_order: 7
description: What to check when a collection doesn't show up, the phone won't connect, Contribute fails, and more.
---

# Troubleshooting
{: .no_toc }

<details open markdown="block">
<summary>On this page</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

## The collection I made doesn't show up
{: #not-listed }

1. Reopen the **Collections** page (reload the browser tab). The list is rebuilt every time it opens
2. If it still isn't there, the blueprint may be broken. Ask in chat:

   > My … collection doesn't show up in the list. Check its schema.json and fix it.

   Claude reads the blueprint, finds what's wrong and fixes it
3. If you just edited `schema.json` by hand, suspect a typo ([How schema.json works](schema.md#edit-by-hand))

{: .note }
When **Installed** is empty it says *"Star a skill that ships a schema from the Skills page to see it
here."* To create a collection, clicking **+ Collection** is all you need.

## I added a record but it isn't in the table

- Check the search box and **Filters** (click any "Only …" or "Hiding …" chip to clear it)
- In the calendar, records without a date go under **No date**

## There's no Calendar or Kanban button

- **Calendar** only appears when there is a date field; **Kanban** only when there is a choice field
- Ask "add a due date" or "add a status (To do / Doing / Done) so I can use a kanban board"

## My phone won't connect

- Check that **Remote host** on your computer is **online**. After restarting MulmoClaude you may need
  to **Reconnect**
- Make sure the phone and the computer use **the same Google account**
- A sleeping computer can't answer. Requests are queued and sent once it's back

## I want to add a record from my phone

There is no direct add screen on the phone yet. Use **Start chat about this collection** and ask
"add …".

## Contribute doesn't work

- Make sure you have run `gh auth login` on your computer
- With the Docker sandbox, put `SANDBOX_MOUNT_CONFIGS=gh` in `.env` and restart
- When asked for your GitHub username, give the name you sign in with (the part after `@`)

## I want a deleted collection back

A backup is saved in your workspace's `archive/` before deletion. Ask Claude:
"Restore the … collection I deleted yesterday from the archive."

## Still stuck?

Ask on [GitHub Issues](https://github.com/receptron/mulmoclaude/issues).
