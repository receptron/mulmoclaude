# fix: play audio and video opened from `/api/files/raw` (#3437)

## Problem

`/api/files/raw?path=…mp3` (or `.mp4`) opened as a top-level document, the way a collection's
`file` link opens it in a new tab, shows Chrome's media player but never plays. Inside the app's
own `<audio>` / `<video>` elements the same file plays fine.

Reproduced on the real server (production mode, headless Chromium): the response carries
`Content-Security-Policy: sandbox`, so the document gets an opaque origin; Chrome's media page
then re-requests the file in CORS mode from `origin 'null'`, the request is blocked for lack of
`Access-Control-Allow-Origin`, and the element stays at `readyState 0` with
`net::ERR_FAILED` in the console. Dropping the header is the whole difference.

## Approach

`rawSecurityHeadersForMime` in `server/api/routes/files.ts` already leaves the sandbox off for
`application/pdf` (WebKit will not render a sandbox-opaque PDF, #1299). `audio/*` and `video/*`
join that exception, for the same kind of reason: the browser cannot show the file under the
sandbox at all. Neither can run script in the document that shows it. A media file is decoded,
not parsed as markup, and `X-Content-Type-Options: nosniff` stays on every response so a
mislabelled file is never sniffed into HTML. SVG, HTML, text, images and unknown types keep the
sandbox: that list widens by accident, and an SVG served without it is stored XSS against
`/api/*`.

The constant that held the PDF carve-out is renamed to say what it is now
(`RAW_SECURITY_HEADERS_NO_SANDBOX`), and the decision lives in one predicate the tests pin in
both directions.

MulmoTerminal merged the same rule in receptron/mulmoterminal#2993
(`server/backends/files/rawServingPlan.ts`); the two hosts agree again.

## Tests

- `test/routes/test_filesRoute.ts`: every `audio/*` and `video/*` MIME the route can emit gets
  the no-sandbox set; PDF still does; SVG, HTML, images, text, octet-stream and near-misses
  (`application/x-pdf`, `audiox/mpeg`, `application/audio`, `audio` without a subtype) keep the
  sandbox; the no-sandbox set still carries `nosniff` and no CORS header.
- Browser proof, not automated: the headless-Chromium script that reproduced the failure is run
  again after the change and the same two files reach `readyState 4` with a duration.

## Out of scope

- A CORS header on `/api/files/raw` instead: it would let any origin read workspace files.
- The in-app previews, which never had the problem.
