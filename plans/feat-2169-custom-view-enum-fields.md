# feat: pass enum field metadata to custom views (#2169, enum half)

Scope: enum values only. The `ref` options half of #2169 stays open.

## Shape

`window.__MC_VIEW.fields = { <field>: { type: "enum", values: string[] } }` —
every top-level `enum` field of the collection schema. Always present in the
bootstrap (`{}` when none / older host).

## Changes

- `@mulmoclaude/core/collection` — `core/viewFields.ts` (pure):
  `buildCustomViewFields(schema)` (server side), `isCustomViewEnumField` +
  `customViewFieldsFrom(unknown)` (client-side narrowing of the mint response;
  drops malformed / unknown-type entries one by one).
- `server/api/routes/collections.ts` — view-token mint response gains `fields`;
  the handler moves behind a deps seam (`createViewTokenHandler`) so the
  response is unit-testable.
- `collection-plugin` — `CollectionViewToken.fields?: unknown`,
  `CollectionViewSrcdocBoot.fields?`, `CollectionCustomView.vue` threads the
  narrowed value into the boot.
- `src/utils/html/customViewSrcdoc.ts` — `CustomViewBootstrap.fields?`, injected
  as `fields: boot.fields ?? {}` (same `<`-escape as the rest of the JSON).
- `packages/core/assets/helps/custom-view.md` — "Enum choices — `fields`" section
  with the `fields?.status?.values ?? FALLBACK` pattern.

## Tests

- `packages/core/test/collection/test_viewFields.ts` — builder + guard, normal
  and abnormal inputs.
- `test/api/routes/test_collectionsViewToken.ts` — the mint response carries
  the schema's enum `fields` (and `{}` without any), caps stay clamped.
- `test/utils/html/test_customViewSrcdoc.ts` — injection, `{}` default, escape.
- `e2e/tests/collection-custom-view-iframe.spec.ts` — the iframe actually sees
  `__MC_VIEW.fields` (malformed entry dropped), and `{}` without it.

Core is bumped to 5.15.0 (the drift gate requires it for a new export) with
every consumer range swept.

## Not done

- `ref` options (remaining half of #2169).
- Mobile / remote-view srcdoc path.
