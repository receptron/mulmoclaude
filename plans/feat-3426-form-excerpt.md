# feat: `presentForm` excerpt block — show the passage next to the question (#3426)

## Problem

Answering review comments one by one needs the passage in view while answering. Today the
highlighted passage can only live on a `presentHtml` canvas (which cannot send an answer back),
and the answer can only go through `presentForm` (which renders plain text only). The user
flips between two surfaces per comment and loses track of which comment they are on.

## Approach

Add a display-only field type to `@mulmoclaude/form-plugin`:

```jsonc
{ "id": "c1_excerpt", "type": "excerpt", "label": "指摘1", "text": "…本文…", "highlights": ["語句"], "description": "根拠" }
```

- Fields render in order, so `excerpt → radio → textarea` per comment puts the answer right
  under the passage. Submission is unchanged (`sendTextMessage`).
- Highlighting is a pure split of `text` into marked / unmarked segments
  (`core/excerpt.ts`), rendered with `<mark>` — no `v-html`, no markdown.
- Every occurrence of each highlight is marked; overlapping ranges merge.

## Rules

- `presentForm` refuses: empty `text`, a highlight that is empty or not found in `text`,
  and a form with no input field.
- The view leaves excerpts out of values, validation, the required count, the preview's
  progress and the submitted text.

## Out of scope

- Rich formatting inside the excerpt (markdown, multiple paragraphs styled differently).
- A send-back bridge for `presentHtml` (option 2 in the issue discussion).

## Release

Ships through `@mulmoclaude/form-plugin` publish → launcher range sweep → `mulmoclaude`
publish. MulmoTerminal picks it up through the same package.
