# feat: schema option to hide the built-in calendar / kanban view toggles (#3677)

## Problem

The collection view offers the Calendar toggle whenever a top-level field is
`date` / `datetime`, and the Kanban toggle whenever one is `enum`. There is no
way to turn either off. Collections read mainly through custom views carry two
toggles that are noise, and the only workaround (retyping the field to
`string`) loses the picker / dropdown and validation — and is impossible when an
`enum` is required by a `toggle` field or `completionField`.

## Scope

- Add an optional `builtinViews: { calendar?: boolean; kanban?: boolean }` to
  the collection schema. `false` hides that view; omitted / `true` keeps today's
  field-derived behaviour, so every existing schema is unchanged.
- Out of scope: choosing a default view (the "nice to have" in the issue). The
  last-used view is already persisted per collection, and a schema default would
  need a precedence rule against that stored choice.

## Design

- `packages/core/src/collection/core/schemaZ.ts`: `builtinViews` as a strict
  object of two optional booleans.
- One pure rule decides which built-in views a schema offers:
  `builtinViewAvailability(schema)` in
  `packages/plugins/collection-plugin/src/vue/collectionViewMode.ts`, returning
  `{ calendar, kanban }` = "has a qualifying field" AND "not opted out".
  `applicableViewModes` (dashboard tile picker) and `CollectionView`
  (`hasCalendar` / `hasKanban`) both route through it, so they cannot drift.
- Calendar chip colouring currently reads `hasKanban ? kanbanGroupField : ''`.
  It must keep working when only the kanban toggle is hidden, so it switches to
  "an enum field exists" instead of `hasKanban`.
- A stored `kanban` / `calendar` mode for an opted-out view already collapses to
  `table` through `resolveActiveViewMode`; no new handling is needed.

## Docs

- `packages/core/assets/helps/collection-skills.md` — calendar and kanban
  sections: document the opt-out.
- `docs/guide/{en,ja}/schema.md` — Appearance table row.

## Tests

- `test/plugins/test_applicableViewModes.ts` — opt-out cases for each view,
  `true` / omitted keep the default, opt-out without the field is a no-op.
- Schema validation: `builtinViews` accepted; non-boolean / unknown keys rejected.

## Release

Version bumps (`@mulmoclaude/core`, `@mulmoclaude/collection-plugin`) are left to
the publish flow, as with other feature PRs.
