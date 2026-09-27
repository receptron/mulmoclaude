---
title: Use a collection
layout: default
parent: English
nav_order: 4
description: Table, calendar and kanban views; adding, editing and deleting records; search and filters; asking Claude; custom views; pinning to the launcher.
---

# Use a collection
{: .no_toc }

<details open markdown="block">
<summary>On this page</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

## Open a collection

On the **Collections** page, **Installed** tab, click the collection's card. Use
**Search collections…** at the top to find one by name.

A collection's page has three rows:

| Row | What's on it |
|---|---|
| **Header** | ← Back, ★ (pin), the title, **Chat**, **Related**, **Add**, **Delete collection** |
| **Toolbar** | **Search records…**, **Filters**, **Table / Calendar / Kanban**, **+** (Add view), **⚙** (Collection settings) |
| **Body** | The table, calendar or kanban — or a custom view |

## Add a record

The simplest way is the **Add** button in the header. An **Add new** form opens; fill it in and click **Save**.

- Choice fields are picked from **Select…**
- Table-shaped fields (line items, for example) grow with **Add row**
- Some fields only appear depending on others (tick "Visited" and "Rating" appears)

### Let Claude add it

When typing is a chore, ask Claude:

> Add "Ramen Taro" to my restaurants — Shinjuku, ramen, not visited yet.

> Add this business card to my contacts (attach a photo)

> Record this receipt in my bills (attach a photo)

When Claude is done, the result is shown in the chat.

## View, edit and delete a record

Click a row and its details open on the right.

| Button | What it does |
|---|---|
| **Edit** | Change the record. Then **Save**, or **Cancel** |
| **Remove** | Delete the record (asks "Delete this item? This cannot be undone.") |
| Buttons from the blueprint | e.g. "Mark paid", "Create invoice" |

Type in **Chat about this record** under the details to ask Claude about that record:
"Turn this invoice into a PDF", "Look up this restaurant's opening hours and add them".

{: .tip }
Checkboxes and choice fields can be changed **directly in the table cell** without opening the details.

## Switch views

Use **Table / Calendar / Kanban** in the toolbar.

| View | When it appears | What you can do |
|---|---|---|
| **Table** | Always | Click a column header to sort (remembered next time) |
| **Calendar** | When there is a date field | A month at a time: **Today**, **Previous month**, **Next month**. Click a day for its list; **+** creates a record on that day |
| **Kanban** | When there is a choice field | Drag a card to another column to change that field. Empty values go to **Uncategorized** |

If there are several date or choice fields, pick which one to use with **Calendar date field** /
**Kanban group field**.

## Linked collections

When collections link to each other (an invoice points at a client, say), **Related** in the header
takes you to the linked collection. The **Map** tab on the Collections page draws all the links.

## Search and filter

- Type in **Search records…** to show only matching records ("Showing 3 of 20")
- If the blueprint defines filter conditions, a **Filters** menu appears. Each click cycles a chip
  through "Hiding …" → "Only …" → off

## Ask Claude

Click **Chat** in the header to open **Start a chat**. Type in
**Describe what you want to do with this collection…** and click **Start chat** — Claude starts
already knowing about this collection.

Things you can ask:

- "What's the total of this month's bills?"
- "Group the restaurants I haven't visited by neighborhood"
- "List the to-dos that are past due"
- "Export this list as CSV"
- "Mark these three as done"

## Custom views (your own look)

When a table or kanban isn't enough, have the look itself built for you:

1. Click **+** (**Add view**) in the toolbar
2. Choose **Custom view** (or **Phone view** for your phone — see [Use it on your phone](share.md#phone))
3. Describe the look you want in the chat that opens

For example: "Show the movies as a grid of posters", "This week's schedule as a timetable",
"Chart my spending".

New views appear as buttons in the toolbar. Delete one you no longer need from **⚙ (Collection settings)**.

## Keep a collection one click away

Click **★** in the collection's header to **Pin to launcher**. It then opens with one click from the
launcher and shows up on the **Dashboard** as a favorite. Click ★ again to **Unpin from launcher**.

## Reminders (the bell)

Collections built to "remind me while it's unfinished" or "N days before the date" show up in the
**bell** at the top of the screen. Mark the record done and it disappears.

## Delete a collection

Use **Delete collection** in the header. **A restorable backup is archived first** (in your
workspace's `archive/`).

---

Next: [Share it, use it on your phone](share.md).
