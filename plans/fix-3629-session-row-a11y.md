# fix: session-history row nests buttons inside a role="button" row (#3629)

## Problem

`src/components/SessionHistoryRow.vue` made the whole card a `div role="button" tabindex="0"` that opened the session, with the kebab `<button>` and its menu items inside it — nested interactive content. The role-icon bookmark shortcut added in #3624 was mouse-only for the same reason.

## Scope

Only `SessionHistoryRow.vue`. The other `role="button"` rows (`src/plugins/manageSkills/Skill*List.vue`, `SkillRepoGroup.vue`) contain no inner controls, so they do not have this defect and are left as they are.

## Change

- The card `div` is no longer a control: no `role`, no `tabindex`, no key handlers. Its `@click` stays as a mouse convenience, so clicking the padding still opens the session.
- Opening the session is a native `<button>` around the primary text (a `<span>`, since a button may hold only phrasing content) and running dot, with the row's aria-label and `aria-current` on the selected row. It has no click handler of its own: the click bubbles to the card, which selects, and on to the panel's document listener, which closes any open row menu.
- The role icon is a native `<button>` toggle, now keyboard-reachable. Its `aria-label` is the fixed "Bookmark" and `aria-pressed` carries the state; the hover `title` still flips between Bookmark / Remove bookmark.
- The timestamp + kebab pill moves to the end of the markup (it is absolutely positioned, so nothing moves on screen) so Tab runs bookmark, open, menu.
- Kebab and menu items keep `@click.stop`; their `@keydown.*.stop` guards are gone because nothing above them handles keys any more.
- `onActivateKey` (the `event.repeat` guard from #684) is removed: activation is now native button behaviour.

## Tests

`e2e/tests/a11y-clickable-rows.spec.ts` is rewritten for the new contract:

- Enter / Space on the open button loads the session.
- The card has no `role` / `tabindex`, no button inside it holds another control or a block element (`p`, `div`), and both controls are `BUTTON`s.
- Enter on the bookmark toggle bookmarks without opening the session, and its accessible name does not change.
- Opening a session from the keyboard closes another row's open menu.
- Tab walks bookmark → open → menu.
- Enter on the kebab opens the menu without opening the session.

The old spec's auto-repeat and `.self` cases tested the hand-rolled key handler, which no longer exists. Run against the old component (`git show origin/main:src/components/SessionHistoryRow.vue`), every new case fails except the kebab one, whose guard already existed.
