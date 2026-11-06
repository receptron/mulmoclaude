# fix: non-GET /api/files routes are reachable without a bearer token (#3628)

## Problem

The `/api` bearer middleware in `server/index.ts` skipped every path starting with `/files/`, so that `<img src="/api/files/raw?…">` loads without an `Authorization` header. That also skipped the routes that write workspace files (`POST create`, `POST upload`, `PUT content`) and start the OS opener / file manager (`POST open`, `POST reveal`). The CSRF guard lets a request with no `Origin` through, so any local process could call them with no token.

Reproduced against a running server built from `main`, with a scratch workspace: with no token, `POST /api/files/create` created the file, `PUT /api/files/content` overwrote one, and `upload` answered 200.

## Change

- `server/api/auth/bearerExemption.ts` (pure, new): `isBearerExempt({ method, path }, isViewDataPath)` decides every exemption the middleware had. `/files/` is now exempt for `GET` / `HEAD` only. The other three exemptions move unchanged: custom-view data paths, runtime-plugin asset GET/HEAD, and the runtime-plugin OAuth callback GET.
- `server/index.ts` calls it instead of the inline checks.
- Client tokens are unchanged: `files` is a client-open segment (`clientTokenAccess.ts`, #3622), so a client token may still write files. Narrowing that is a separate decision.
- Docs that described the old exemption are updated: README, `docs/developer.md`, `docs/image-path-routing.md`, the comments in `bearerAuth.ts` and `files.ts`, and the CHANGELOG.

## Verification

- `test/server/test_bearerExemption.ts` covers every files route in both directions, the other non-read methods, look-alike paths, and the three other exemptions.
- The old inline logic, copied verbatim into a throwaway harness, was run beside `isBearerExempt` over generated method × path inputs, with several seeds. The only differences were the intended ones: a non-GET/HEAD method under `/files/`. Each of four mutations of the new function (asset HEAD dropped, view-data dropped, OAuth HEAD added, the fix reverted) was caught by the harness and by the unit test.
- Live server, `main` vs this branch, same probe: without a token the five write routes now answer 401 and nothing changes on disk, `GET` / `HEAD` raw and `GET` content still answer 200, and with the token create / PUT succeed.
