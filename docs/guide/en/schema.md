---
title: How schema.json works
layout: default
parent: English
nav_order: 6
description: How to read a collection's blueprint, schema.json — field types, conditional fields, buttons (actions), reminders and custom views.
---

# How schema.json works
{: .no_toc }

{: .note }
You **do not need this page** to build collections. Claude writes the blueprint, and it is checked
before it is saved. This is for anyone who wants to know what is inside and what they can ask for.

<details open markdown="block">
<summary>On this page</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

## A small example

A restaurants collection might have this blueprint:

```json
{
  "title": "Restaurants",
  "icon": "restaurant",
  "dataPath": "data/restaurants/items",
  "primaryKey": "id",
  "fields": {
    "id":      { "type": "string",  "label": "ID", "primary": true, "required": true },
    "name":    { "type": "string",  "label": "Name", "required": true },
    "cuisine": { "type": "enum",    "label": "Cuisine", "values": ["Japanese", "Chinese", "Italian", "Other"] },
    "visited": { "type": "boolean", "label": "Visited" },
    "rating":  { "type": "number",  "label": "Rating", "when": { "field": "visited", "in": ["true"] } },
    "notes":   { "type": "text",    "label": "Notes" }
  }
}
```

How to read it:

| Part | Meaning |
|---|---|
| `title` / `icon` | The name and icon shown on screen (a [Material Symbols](https://fonts.google.com/icons) name, or one emoji) |
| `dataPath` | The folder records are kept in |
| `primaryKey` | Which field is the ID (= the record's file name) |
| `fields` | The fields. Their order is the column order in the table |
| `"when"` | Conditional display. Here "Rating" stays hidden until "Visited" is ticked |

## Field types

| Type | Holds | On screen |
|---|---|---|
| `string` | One line of text | Text box |
| `text` | Several lines of text | Large text box |
| `markdown` | Text with headings and lists | Rendered |
| `email` | An email address | |
| `number` | A number | |
| `money` | An amount with a currency | Formatted as money |
| `date` | A date (`2026-10-01`) | Enables the **Calendar** view |
| `datetime` | A date and time (`2026-10-01T19:00`) | Same |
| `boolean` | Yes / no | Checkbox, toggled right in the table |
| `enum` | One of a fixed set of choices | Dropdown. Enables the **Kanban** view |
| `image` | An image | Shown in the details |
| `file` | A file | A link that opens it |
| `table` | Rows inside the record (line items, say) | **Add row** / **Remove row** |
| `ref` | A link to a record in another collection | An invoice → its client |
| `embed` | Shows another collection's record inside this one | |
| `backlinks` | Records that point here (the reverse of `ref`) | A client's invoices |
| `rollup` | A sum or count over `backlinks` | Total billed per client |
| `derived` | A computed value (`+ - * /`, sums…) | Quantity × unit price |
| `toggle` | A checkbox that drives a choice field | "Done" ⇔ status is "Done" |
| `flag` | Whether a condition holds (computed) | Appears in the **Filters** menu |

## Buttons (actions)

Buttons can go on a record's details or in the collection's header. There are three kinds:

| Kind | When clicked | Good for |
|---|---|---|
| `chat` | **Starts a chat with Claude** about that record | Make an invoice PDF, draft an email |
| `agent` | **Claude works in the background** and updates the record (no chat) | Fetch the latest stock price, look something up and fill it in |
| `mutate` | **No Claude** — writes fixed values instantly | "Mark paid", "Assign" |

Ask "add a … button" and Claude picks the right kind.

## Reminders (the bell)

| Setting | Meaning |
|---|---|
| `completionField` + `completionDoneValues` | Remind about records that are not done |
| `notifyWhen` | Only remind about records matching a condition |
| `triggerField` + `triggerLeadDays` | Start reminding N days before a date |
| `spawn` | When one is done, create the next one (monthly bills, say) |

## Appearance

| Setting | Meaning |
|---|---|
| `calendarField` | Which date the calendar uses |
| `kanbanField` | Which choice field splits the kanban columns |
| `displayField` | Which field names a record on cards and reminders |
| `color` | The collection's color (`violet` `indigo` `sky` `teal` `emerald` `lime` `fuchsia`) |
| `views` | Custom views (free-form looks built in HTML). Phone views use `"target": "mobile"` |

## Editing it yourself
{: #edit-by-hand }

You can edit `schema.json` in an editor, but a mistake makes the collection **disappear from the list**
(a broken blueprint is not loaded). Asking Claude ("change … to …") checks the whole blueprint before
writing, so that is the recommended way.

The full specification is Claude's own how-to,
[collection-skills.md](https://github.com/receptron/mulmoclaude/blob/main/packages/core/assets/helps/collection-skills.md).

---

Next: [Troubleshooting](faq.md).
