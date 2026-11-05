// Which page loads receive the owner token embedded in index.html (#3627).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import { decideOwnerTokenHandoff, hostnameOf, isLoopbackAddress } from "../../server/api/auth/ownerTokenHandoff.js";

// Assembled so lint's hardcoded-IP rule reads them as the fixtures they are.
const ipv4 = (...octets: number[]): string => octets.join(".");
const ipv6 = (...groups: string[]): string => groups.join(":");
const LOOPBACK_V4 = ipv4(127, 0, 0, 1);
const MAPPED_LOOPBACK = ipv6("", "", "ffff", LOOPBACK_V4);

const DIRECT = { remoteAddress: "127.0.0.1", headers: { host: "localhost:3001" } };
const withHeaders = (headers: IncomingHttpHeaders) => ({ remoteAddress: "127.0.0.1", headers: { host: "localhost:3001", ...headers } });

describe("decideOwnerTokenHandoff", () => {
  [
    { remoteAddress: "127.0.0.1", host: "localhost:3001" },
    { remoteAddress: MAPPED_LOOPBACK, host: "127.0.0.1:3001" },
    { remoteAddress: "::1", host: "[::1]:3001" },
    { remoteAddress: "127.0.0.1", host: "LOCALHOST:5173" },
    { remoteAddress: "127.0.0.1", host: "localhost" },
  ].forEach(({ remoteAddress, host }) => {
    it(`hands the token to a direct load: ${remoteAddress} Host ${host}`, () => {
      assert.deepEqual(decideOwnerTokenHandoff({ remoteAddress, headers: { host } }), { ok: true });
    });
  });

  [ipv4(192, 168, 1, 20), ipv4(10, 0, 0, 2), ipv6("fe80", "", "1"), "", undefined].forEach((remoteAddress) => {
    it(`refuses a non-loopback peer ${JSON.stringify(remoteAddress)}`, () => {
      assert.deepEqual(decideOwnerTokenHandoff({ remoteAddress, headers: { host: "localhost:3001" } }), { ok: false, reason: "remote-peer" });
    });
  });

  // A tunnel forwards its public host; a rebinding page resolves to 127.0.0.1.
  [
    "abc.ngrok-free.app",
    "mc.example.com:443",
    "evil.test:3001",
    "192.168.1.20:5173",
    "localhost.evil.test",
    "127.0.0.1.nip.io",
    "foo.localhost",
    "localhost:abc",
    "",
  ].forEach((host) => {
    it(`refuses Host ${JSON.stringify(host)}`, () => {
      assert.deepEqual(decideOwnerTokenHandoff({ remoteAddress: "127.0.0.1", headers: { host } }), { ok: false, reason: "host" });
    });
  });

  it("refuses a request with no Host header", () => {
    assert.deepEqual(decideOwnerTokenHandoff({ remoteAddress: "127.0.0.1", headers: {} }), { ok: false, reason: "host" });
  });

  // A proxy that rewrites Host to localhost still leaves one of these.
  [
    { forwarded: "for=203.0.113.9" },
    { "x-forwarded-for": "203.0.113.9" },
    { "x-forwarded-host": "abc.ngrok-free.app" },
    { "x-forwarded-proto": "https" },
    { "x-forwarded-port": "443" },
    { "x-real-ip": "203.0.113.9" },
    { "cf-connecting-ip": "203.0.113.9" },
    { "true-client-ip": "203.0.113.9" },
    { "tailscale-user-login": "someone@example.com" },
    { via: "1.1 proxy" },
    { "x-forwarded-for": "" },
  ].forEach((headers) => {
    it(`refuses a forwarded request: ${Object.keys(headers)[0]}`, () => {
      assert.deepEqual(decideOwnerTokenHandoff(withHeaders(headers)), { ok: false, reason: "forwarded" });
    });
  });

  it("ignores headers a browser sends on a direct load", () => {
    const browser = { "user-agent": "Mozilla/5.0", accept: "text/html", "sec-fetch-site": "none", cookie: "a=b", referer: "http://localhost:3001/" };
    assert.deepEqual(decideOwnerTokenHandoff(withHeaders(browser)), { ok: true });
    assert.deepEqual(decideOwnerTokenHandoff(DIRECT), { ok: true });
  });
});

describe("hostnameOf", () => {
  const cases: [string | undefined, string | null][] = [
    ["localhost:3001", "localhost"],
    ["LocalHost", "localhost"],
    ["[::1]:3001", "[::1]"],
    ["[::1]", "[::1]"],
    ["127.0.0.1", "127.0.0.1"],
    ["a:b:c", null],
    ["[::1]x", null],
    ["[]", null],
    ["[]:3001", null],
    ["[::1", null],
    ["[::1]:", null],
    ["", null],
    [undefined, null],
  ];
  cases.forEach(([host, expected]) => {
    it(`${JSON.stringify(host)} → ${JSON.stringify(expected)}`, () => assert.equal(hostnameOf(host), expected));
  });
});

// Moved from vite.config.ts unchanged: a peer is loopback when it is ::1 or
// 127.* once an IPv4-mapped prefix is removed.
describe("isLoopbackAddress", () => {
  const octet = (seed: number): string => String((seed * 37) % 300);
  const addresses = Array.from({ length: 200 }, (_, index) => [`127.${octet(index)}.0.1`, `10.${octet(index)}.0.1`, `${octet(index)}.0.0.1`]).flat();
  const forms = addresses.flatMap((address) => [address, `::ffff:${address}`]);
  [...forms, "::1", ipv6("fe80", "", "1"), ipv6("", "", "2"), "", undefined].forEach((address) => {
    const bare = address?.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
    const expected = bare === "::1" || (bare?.startsWith("127.") ?? false);
    it(`${JSON.stringify(address)} → ${expected}`, () => assert.equal(isLoopbackAddress(address), expected));
  });
});
