# feat: toggle bookmark by clicking the session role icon (#1685)

## Problem

A bookmarked session's role icon turns green in the session-history list, so it looks clickable, but clicking it only opens the session. Toggling a bookmark takes the `…` menu.

## Change

- `src/components/SessionHistoryRow.vue`: wrap the row's `SessionRoleIcon` in a `<span>` whose `@click.stop` emits the existing `toggleBookmark` event, with a localized `title` (the existing `sessionHistoryPanel.bookmark` / `unbookmark` keys). It is a mouse-only shortcut on purpose: a `<button>` would nest another control inside the `role="button"` row. Keyboard and screen-reader users keep the kebab menu's Bookmark item.
- The row's own nesting (kebab + menu inside `role="button"`) predates this change and is pinned by `e2e/tests/a11y-clickable-rows.spec.ts`; restructuring it is a separate issue.
- `SessionRoleIcon.vue` stays non-interactive, because `SessionTabBar` uses it too.
- The `…` menu item stays as well.

## Test

`e2e/tests/history-panel.spec.ts`: clicking the icon POSTs `{bookmarked: true}`, then `{bookmarked: false}`, flips the title, and does not navigate to the session.
