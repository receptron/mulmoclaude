---
title: Create a collection
layout: default
parent: English
nav_order: 3
description: Three ways to create a collection (guided, free-form, sample prompts), creating one from chat, and reshaping it later.
---

# Create a collection
{: .no_toc }

<details open markdown="block">
<summary>On this page</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

## Open the Collections page

Click **Collections** in the **launcher** (the column of icons on the left), or open
[http://localhost:3001/collections](http://localhost:3001/collections).

There are three tabs at the top:

| Tab | What it shows |
|---|---|
| **Installed** | The collections you have |
| **Discover** | Collections other people have published — import one with a click ([Share](share.md#discover)) |
| **Map** | How your collections link to each other (only shown when they do) |

## Way 1: the "+ Collection" button (easiest)

On the **Installed** tab, click **+ Collection**. A **New collection** window opens with three ways in.

### Guided setup (recommended)

Click **Guided setup — Claude asks what to track, then builds it**. Claude asks you questions in a form:
what you want to track, which fields you need. Answer them and the blueprint gets built.
**If you are not sure what to write, pick this one.**

### Free-form chat

Click **Free-form chat — Describe the collection in your own words**. An opening sentence is placed in
the chat box; add a description of what you want in your own words and send it.

### Sample prompts

The lower half of the window, **Sample prompts**, lists ready-made examples:

| Sample | What you get |
|---|---|
| Todo list | A to-do list with kanban, due dates and reminders |
| Contacts | Contacts — attach a photo of a business card and it reads it in |
| Reading list | Reading list; stays in your notifications until you tick "Read" |
| Restaurants | Restaurants; you can rate a place only after you've been |
| Bill Payments | Monthly bills; reminds you 10 days ahead, creates next month's bill |
| Clients & time | Clients and hours worked |
| Invoicing | Invoices |
| Vocabulary | A vocabulary notebook |
| Lessons | Lessons and classes |
| Stock portfolio | A stock portfolio |

Clicking a card puts its prompt in the chat box — **it is not sent yet**. Edit it first if you like
("also add a cuisine field"), then send.

## Way 2: just ask in chat

You can also ask from the normal chat screen. The trick is to say **what**, **which fields**, and
**how you want to use it**.

**Example 1: reading list**

> Create a reading-list collection with a title, a URL field, and a Read checkbox.
> While Read is unchecked, keep each item in the bell notifications, labeled with its title.

**Example 2: restaurants**

> Create a restaurants collection with name, cuisine, neighborhood, a website URL, a phone number,
> a Visited checkbox, a 1-to-5 rating, and notes. Hide the rating until I've marked a place as visited.

**Example 3: kids' activities**

> I want to track my kids' activities: name, day of the week, time, monthly fee in yen, and the
> teacher's contact. Let me see them on a calendar.

When Claude is done, the collection appears in the chat and is added to the **Collections** list
automatically. **No restart needed.**

{: .tip }
Don't aim for perfect on the first try. Start small and add as you go — that works best.

## Reshape it later

Open the collection and click **Chat** in its header, or mention the collection by name in any chat:

- "Add a priority field — High, Medium or Low"
- "Make the notes field multi-line"
- "Remind me 3 days before the due date"
- "Let me see it as a kanban board"
- "Add a 'Mark paid' button"
- "Make a custom view that shows them as cards"

Records you already have are kept.

## If you get stuck

- The collection you made doesn't show up → [Troubleshooting](faq.md#not-listed)
- Which field types exist → [How schema.json works](schema.md)

---

Next: [Use a collection](use.md).
