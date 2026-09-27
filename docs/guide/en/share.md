---
title: Share it, use it on your phone
layout: default
parent: English
nav_order: 5
description: Import published collections (Discover), publish your own (Contribute), use collections from your phone, get other people's input, and hand collections over as files.
---

# Share it, use it on your phone
{: .no_toc }

There are several ways to share a collection. Pick by what you want to do:

| You want to… | How |
|---|---|
| Use a collection someone else made | [Import it from Discover](#discover) |
| Publish yours so anyone can use it | [Contribute it](#contribute) |
| See and use your collections on your phone when you are out | [Use it on your phone](#phone) |
| Have family or colleagues enter records | [Other people's input](#others) |
| Hand the whole thing to a friend | [Hand over the files](#files) |

<details open markdown="block">
<summary>On this page</summary>
{: .text-delta }
1. TOC
{:toc}
</details>

## Import someone else's collection (Discover)
{: #discover }

The **Discover** tab on the **Collections** page shows published collections as cards. Right now they
come from the official registry,
[receptron/mulmoclaude-collections](https://github.com/receptron/mulmoclaude-collections): a movie list,
a camera-lens catalogue, Japan Meteorological Agency weather forecasts, and more.

Each card shows:

- The title and **by {author}**
- **{count} fields**, the custom views it ships, and **{count} samples**
- Which registry it came from (a badge such as **official**)

### Steps

1. Click **Import** on the card (it shows **Importing…**)
2. When it turns into **Imported · Open**, click it to open the collection
3. It is now on the **Installed** tab too

Importing copies the blueprint, custom views and sample records into your workspace. From then on
**it is yours**: add records, or ask Claude to reshape it.

{: .note }
If you already have a collection with the same name, it is imported under another name such as
`movies-2` (**Imported as movies-2**). Importing the same one again updates only the blueprint to the
new version (**Updated**); your records are left alone.

### Add more registries (advanced)

If your company or community runs its own registry, add it to `config/collections-registries.json`
in your workspace and it appears on the Discover tab alongside the official one.

```json
[
  {
    "name": "my-team",
    "indexUrl": "https://example.github.io/my-collections/index.json",
    "rawBaseUrl": "https://raw.githubusercontent.com/example/my-collections/main"
  }
]
```

Reload the browser tab afterwards. Details are in the developer doc
[collection-registries.md](https://github.com/receptron/mulmoclaude/blob/main/docs/collection-registries.md).

## Publish your collection (Contribute)
{: #contribute }

A collection you are proud of can go into the official registry and appear on everyone's **Discover** tab.

### What you need

- A **GitHub account**
- The **GitHub CLI (`gh`)** installed on your computer and signed in (run `gh auth login` once)

{: .warning }
If you run MulmoClaude **with the Docker sandbox**, Claude cannot use your GitHub sign-in as is.
Put `SANDBOX_MOUNT_CONFIGS=gh` in `.env` and restart MulmoClaude so it can use the `gh` sign-in from
your computer.

### Steps

1. On the **Installed** tab, click the **share icon (Contribute)** on the collection's card
2. It asks *Share the "…" collection? This runs a skill that exports it and opens a GitHub PR to the
   collection registry…* — click **Contribute**
3. A new chat starts and Claude does the work. Along the way it asks you:
   - Your **GitHub username** (it becomes the author name)
   - Finally, whether it may **open the PR** (the request to publish)
4. Once the registry maintainers review and merge it, it shows up on everyone's **Discover** tab

### Your records are not published

What gets published is **the blueprint and custom views**. The sample records that come with it are not
your real records but **3–5 made-up records Claude generates from the blueprint**. Anything that looks
like a password or API key makes the registry's checks fail automatically.

## Use it on your phone
{: #phone }

You can reach the MulmoClaude running on your computer from your phone, anywhere. No port forwarding or
network setup — **just sign in with the same Google account on both**.

### On your computer

1. Click the **Remote host** button at the top of MulmoClaude (the phone-and-computer icon)
2. Click **Sign in with Google**
3. When it says **Remote host online** and the button turns green, you are set

{: .note }
After restarting MulmoClaude you may need to connect again. If the link drops you'll see
**Remote host disconnected** — click **Reconnect**.

### On your phone

1. Open **[mulmoserver.web.app](https://mulmoserver.web.app)** in your phone's browser
   (or scan the **QR code** shown in the **Remote host** window on your computer)
2. **Sign in with Google account** — the same account as on your computer
3. Under **Host** on the home screen, tap **MulmoClaude**
4. Open **Collections** — your computer's collections are there

### What works on the phone

| You can | How |
|---|---|
| Browse collections and records | Open a collection; records are cards, **Load more** shows the rest |
| Use a phone-friendly look | Pick a **phone view** made on your computer from **Switch view** (below) |
| Edit or delete records | Only the fields a phone view allows |
| Ask Claude | **Start chat about this collection** / **Start chat about this item** — photos can be attached |
| Ask while your computer is off | The request is queued (**Queue chat**) and sent when the computer is back (kept for 7 days) |

{: .warning }
There is **no screen for adding a new record directly on the phone yet**. To add one, ask in chat
("add …") — attach a photo and Claude will read it in.

### Make a phone view

Phone-friendly looks are made on the computer:

1. Open the collection on your computer, click **+** (**Add view**) → **Phone view**
2. Tell Claude how you want to use it on your phone:

   > I'll look at this while shopping. Show only what I haven't bought yet, in large text, and let me
   > tap to mark it bought.

3. A preview at phone size appears on your computer

Tell Claude here, too, which fields the phone may change, and whether a button should run Claude right
away or open an editable draft first.

{: .note }
Only **your own Google account** can reach your computer. Nobody else's account can.

## Other people's input
{: #others }

**MulmoClaude does not currently have a way to open a collection to other people for input (no share
links, no public forms).** Phone access is also limited to your own Google account.

What you can do instead:

| Option | Good for | Keep in mind |
|---|---|---|
| **Let them ask through a messaging app** — connect Telegram, LINE and others to MulmoClaude ([MulmoBridge Guide](https://github.com/receptron/mulmoclaude/blob/main/docs/mulmobridge-guide.en.md)) and have family send "add …" | Family and very close people | Anyone you allow can talk to **Claude itself** — it is not limited to one collection |
| **Use MulmoTerminal's shared apps** — the sibling app [MulmoTerminal](https://www.mulmoterminal.com/) builds apps many people fill in — surveys, sign-up sheets, booking pages — and you hand out a link. They keep working with your laptop closed | Event sign-ups, team records | A separate app; it does not publish your MulmoClaude collections as they are. See [Shared apps](https://www.mulmoterminal.com/guide/en/shared-apps.html) |
| **Share the design, not the data** — have them use MulmoClaude too, and import / copy the same collection | Spreading a way of keeping records | Records are not shared; each person keeps their own |

## Hand over the files
{: #files }

A collection is ordinary files, so handing over the folder is enough for someone else to use it.

### If you are giving it

Copy these from your workspace (`~/mulmoclaude`):

| What | Where | Needed? |
|---|---|---|
| The collection (blueprint, instructions, views) | `.claude/skills/<slug>/` (`SKILL.md`, `schema.json`, `views/`, `templates/`) | Yes |
| Records | The folder named by `dataPath` in the blueprint (usually `data/<name>/items/`) | Only if you want to share records too |

{: .tip }
If the custom views are not in `.claude/skills/<slug>/`, they are in `data/skills/<slug>/views/` — copy
them too. When in doubt, ask Claude: "Put the restaurants collection in one folder I can give to someone."

### If you are receiving it

1. Put the folder in your workspace at `.claude/skills/<slug>/`
2. If you got records too, put them at the blueprint's `dataPath`
3. Reopen the **Collections** page (no restart needed)

Or show Claude the folder and say "import this as a collection".

{: .warning }
Records may contain personal information — check them before handing them over.
Image and file fields point at locations on your computer, so the images themselves have to travel
too or they will not show on the other side.

---

Next: [How schema.json works](schema.md) (for the curious).
