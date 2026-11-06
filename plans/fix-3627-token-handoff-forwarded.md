# fix: hand the owner token only to a direct localhost page load (#3627)

## Problem

`GET /` embeds the owner bearer token in `index.html` for any caller. The
server binds `127.0.0.1`, so the realistic leak is a tunnel or reverse proxy
the user puts in front of it (ngrok, cloudflared, tailscale serve, nginx):
then anyone who can reach that public address reads the owner token with one
GET, and every bearer check and every client-token refusal (#3618) is moot.
The dev server already refuses non-loopback peers, but a tunnel to
`localhost:5173` is a loopback peer too.

## Scope (agreed with the user)

Close the forwarded path only. A process on the same machine can still read
the token (the same user could read `.session-token` anyway; another user on
the machine is not covered). The one-time-code + cookie design stays open on
#3627.

## Rule

`server/api/auth/ownerTokenHandoff.ts` (pure): the page gets the token only
when ALL hold:

- the peer address is loopback (`127.0.0.0/8`, `::1`, `::ffff:127.*`);
- the request target is origin-form (`/…`), not a forward proxy's
  absolute-form `http://host/…`;
- there is exactly one `Host` field (Node keeps only the first of two), and
  its hostname is one of `localhost`, `127.0.0.1`, `[::1]`
  (a permitted list: a proxy that forwards the public host is refused, and so
  is a DNS-rebinding page);
- no proxy header is present (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`,
  `CF-Connecting-IP`, `True-Client-IP`, `Tailscale-User-Login`, `Via`) —
  catches a proxy that rewrites `Host` to `localhost`.

Otherwise the page is served with an empty token, which the client already
treats as "no auth" (API calls 401, the stale-token banner offers Reload),
and the server logs why, without the token. The production page is sent
`Cache-Control: no-store`, so no cache in between can replay a token-bearing
response.

## Wiring

- Production: the `GET /{*splat}` handler in `server/index.ts`.
- Dev: `mulmoclaudeAuthTokenPlugin` in `vite.config.ts` (its loopback check
  is replaced by the shared rule).

## Behaviour change

Opening the web UI through a tunnel or proxy no longer works (it worked only
by handing out the owner token). Phones use the remote-host channel.
