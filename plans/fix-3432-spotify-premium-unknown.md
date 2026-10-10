# fix: Spotify Premium users blocked by `premium_required` (#3432)

## Problem

`/v1/me` does not return `product` for the plugin's apps: `user-read-private` is not in
`SPOTIFY_SCOPES`, and the reporter cites Spotify's February 2026 Development Mode change
removing the field. `fetchProfile` falls back to `"free"`, so every account counts as Free.
`premiumGate` then refuses playback, and the View shows the locked notice instead of the
controls. The Player API itself works for a Premium account.

## Change

- `profile.ts`: a missing `product` is stored as `null` ("Spotify did not say"), never as
  `"free"`. `isPremium` returns `boolean | null`.
- Cache: `profile.json` written by the old parser holds a fabricated `"free"` that cannot be
  told apart from a real one. A cache-format marker is written with each snapshot, and a cache
  without it is a miss, so the bad value is re-fetched instead of served for up to 24 h.
- `premiumGate`: refuses up front only when `isPremium` is `false` (Spotify said non-premium).
  Unknown goes through to Spotify.
- `mapPlayerError`: a 403 whose body carries `PREMIUM_REQUIRED` maps to the same
  `premium_required` response the gate gives, so a Free account still gets the same message.
- `View.vue`: the controls and Transfer show unless `isPremium === false`.

Not done: adding `user-read-private` (no help for Development Mode apps per the report, and it
would force every user to reconnect).

## Separate PR

Track / album / playlist URIs in the search summary, so a hit can be passed to `play`.

## Tests

- profile: missing `product` → `null`, `isPremium` → `null`; a cache without the marker is
  re-fetched; a cache with it is served.
- dispatch: unknown product reaches the player call; explicit Free is still refused without a
  call; a `PREMIUM_REQUIRED` 403 maps to `premium_required`, a scope 403 still maps to
  `scope_missing`.
