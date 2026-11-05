# feat: toggle bookmark by clicking the session role icon (#1685)

## Problem
A bookmarked session's role icon turns green in the session-history list, so it looks clickable, but clicking it only opens the session. Toggling a bookmark takes the `…` menu.

## Change
- `src/components/SessionHistoryRow.vue`: wrap the row's `SessionRoleIcon` in a `<button>` that emits the existing `toggleBookmark` event. `@click.stop` and `@keydown.enter/space.stop` keep the row's own select handler from also firing. The aria-label / title reuse the existing `sessionHistoryPanel.bookmark` / `unbookmark` keys, so no new i18n keys are needed.
- `SessionRoleIcon.vue` stays non-interactive, because `SessionTabBar` uses it too.
- The `…` menu item stays as well.

## Test
`e2e/tests/history-panel.spec.ts`: clicking the icon POSTs `{bookmarked: true}`, then `{bookmarked: false}`, flips the label, and does not navigate to the session.
