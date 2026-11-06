// Settings → client tokens (#3637): last-used times, the batched usage file,
// the store revoke the page uses, and the list / revoke routes.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import {
  listClientTokens,
  noteClientTokenUse,
  parseClientTokenUsage,
  serializeClientTokenUsage,
  usageMinuteIso,
  type ClientTokenUsage,
} from "../../server/api/auth/clientTokenUsageRule.js";
import { createClientTokenUsageTracker } from "../../server/api/auth/clientTokenUsage.js";
import { addClientToken, type ClientTokenRecord } from "../../server/api/auth/clientTokenRule.js";
import {
  ClientTokenLockBusyError,
  clientTokenUsagePath,
  clientTokensPath,
  readClientTokenFile,
  revokeStoredClientToken,
  writeClientTokenFile,
} from "../../server/api/auth/clientTokenStore.js";
import { listStoredClientTokens, resolveTokenPrincipal } from "../../server/api/auth/principal.js";
import { createClientTokensRouter, type ClientTokensDeps } from "../../server/api/routes/clientTokens.js";
import { bearerAuth } from "../../server/api/auth/bearerAuth.js";
import { __resetForTests, generateAndWriteToken } from "../../server/api/auth/token.js";
import { API_ROUTES } from "../../src/config/apiRoutes.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { isolateHome } from "../helpers/isolatedHome.js";
import { ONE_MINUTE_MS, ONE_SECOND_MS } from "../../server/utils/time.js";

const NOW = "2026-11-06T00:00:00.000Z";
const ID_A = "a".repeat(16);
const ID_B = "b".repeat(16);
const START_MS = Date.parse("2026-11-06T10:20:30.400Z");
const realRandomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

function issue(records: readonly ClientTokenRecord[], name: string): { records: ClientTokenRecord[]; token: string } {
  const result = addClientToken(records, { name, nowIso: NOW, randomHex: realRandomHex });
  if (!result.ok) throw new Error(`could not issue ${name}: ${result.reason}`);
  return { records: result.records, token: result.token };
}

describe("usage rule", () => {
  it("rounds a use down to its minute", () => {
    assert.equal(usageMinuteIso(START_MS), "2026-11-06T10:20:00.000Z");
    assert.equal(usageMinuteIso(START_MS - (START_MS % ONE_MINUTE_MS)), "2026-11-06T10:20:00.000Z");
  });

  it("reports a change only when the minute moves", () => {
    const usage: ClientTokenUsage = new Map();
    assert.equal(noteClientTokenUse(usage, ID_A, START_MS), true);
    assert.equal(noteClientTokenUse(usage, ID_A, START_MS + 10 * ONE_SECOND_MS), false);
    assert.equal(noteClientTokenUse(usage, ID_A, START_MS + ONE_MINUTE_MS), true);
    assert.equal(noteClientTokenUse(usage, ID_B, START_MS), true);
    assert.equal(usage.get(ID_A), "2026-11-06T10:21:00.000Z");
  });

  it("round-trips the file and keeps only live ids", () => {
    const usage: ClientTokenUsage = new Map([
      [ID_A, "2026-11-06T10:20:00.000Z"],
      [ID_B, "2026-11-06T10:21:00.000Z"],
    ]);
    const parsed = parseClientTokenUsage(JSON.parse(serializeClientTokenUsage(usage, [ID_A])));
    assert.deepEqual([...parsed], [[ID_A, "2026-11-06T10:20:00.000Z"]]);
  });

  [null, 7, "x", [], {}, { version: 2, lastUsed: {} }, { version: 1 }, { version: 1, lastUsed: [] }].forEach((raw) => {
    it(`reads ${JSON.stringify(raw)} as empty`, () => assert.equal(parseClientTokenUsage(raw).size, 0));
  });

  it("drops malformed entries and keeps the rest", () => {
    const raw = { version: 1, lastUsed: { [ID_A]: "2026-11-06T10:20:00.000Z", short: NOW, [ID_B]: "not a date", ["c".repeat(16)]: 5 } };
    assert.deepEqual([...parseClientTokenUsage(raw)], [[ID_A, "2026-11-06T10:20:00.000Z"]]);
  });

  it("lists records with their last use and never a hash", () => {
    const { records } = issue(issue([], "one").records, "two");
    const [first, second] = records;
    const listing = listClientTokens(records, new Map([[first?.id ?? "", "2026-11-06T10:20:00.000Z"]]));
    assert.deepEqual(
      listing.map((row) => [row.name, row.lastUsedAt]),
      [
        ["one", "2026-11-06T10:20:00.000Z"],
        ["two", null],
      ],
    );
    assert.equal(JSON.stringify(listing).includes(second?.sha256 ?? "-"), false);
  });
});

describe("usage tracker", () => {
  const paths = { file: "" };
  beforeEach(() => {
    paths.file = path.join(makeTempDir("mulmo-client-token-usage-"), ".mulmoclaude", "client-tokens-usage.json");
  });

  function tracker(liveIds: string[] = [ID_A, ID_B], clock = { nowMs: START_MS }) {
    return createClientTokenUsageTracker({ filePath: paths.file, liveIds: () => liveIds, now: () => clock.nowMs, flushDelayMs: ONE_MINUTE_MS });
  }

  it("writes nothing until something was used", () => {
    tracker().flush();
    assert.throws(() => statSync(paths.file));
  });

  it("flushes the uses, owner-only, and drops revoked ids", () => {
    const live = [ID_A];
    const usage = tracker(live);
    usage.note(ID_A);
    usage.note(ID_B);
    usage.flush();
    const written = parseClientTokenUsage(JSON.parse(readFileSync(paths.file, "utf8")));
    assert.deepEqual([...written], [[ID_A, "2026-11-06T10:20:00.000Z"]]);
    assert.equal(statSync(paths.file).mode & 0o777, 0o600);
  });

  it("does not rewrite the file for a use in the same minute", () => {
    const clock = { nowMs: START_MS };
    const usage = tracker(undefined, clock);
    usage.note(ID_A);
    usage.flush();
    const before = statSync(paths.file).mtimeMs;
    clock.nowMs += 10 * ONE_SECOND_MS;
    usage.note(ID_A);
    usage.flush();
    assert.equal(statSync(paths.file).mtimeMs, before);
  });

  it("starts from what an earlier run wrote", () => {
    const first = tracker();
    first.note(ID_A);
    first.flush();
    assert.equal(tracker().snapshot().get(ID_A), "2026-11-06T10:20:00.000Z");
  });

  it("treats a broken file as empty and replaces it on the next flush", () => {
    mkdirSync(path.dirname(paths.file), { recursive: true });
    writeFileSync(paths.file, "{broken");
    const usage = tracker();
    assert.equal(usage.snapshot().size, 0);
    usage.note(ID_B);
    usage.flush();
    assert.equal(parseClientTokenUsage(JSON.parse(readFileSync(paths.file, "utf8"))).get(ID_B), "2026-11-06T10:20:00.000Z");
  });

  it("keeps the change when a write fails, and writes it on a later flush", () => {
    // A directory where the file belongs makes the atomic rename fail.
    mkdirSync(paths.file, { recursive: true });
    const usage = tracker();
    usage.note(ID_A);
    usage.flush();
    assert.equal(statSync(paths.file).isDirectory(), true);
    rmSync(paths.file, { recursive: true });
    usage.flush();
    assert.equal(parseClientTokenUsage(JSON.parse(readFileSync(paths.file, "utf8"))).get(ID_A), "2026-11-06T10:20:00.000Z");
  });
});

describe("revokeStoredClientToken", () => {
  const paths = { store: "" };
  beforeEach(() => {
    paths.store = path.join(makeTempDir("mulmo-client-token-revoke-"), ".mulmoclaude", "client-tokens.json");
  });

  it("removes only that token and reports an unknown name", () => {
    const { records } = issue(issue([], "one").records, "two");
    writeClientTokenFile(paths.store, records);
    assert.equal(revokeStoredClientToken(paths.store, "one"), true);
    assert.deepEqual(
      readClientTokenFile(paths.store).records.map((record) => record.name),
      ["two"],
    );
    assert.equal(revokeStoredClientToken(paths.store, "one"), false);
  });

  it("refuses while a token command holds the lock, changing nothing", () => {
    writeClientTokenFile(paths.store, issue([], "one").records);
    const before = readFileSync(paths.store, "utf8");
    writeFileSync(`${paths.store}.lock`, `${process.pid}\n`);
    assert.throws(() => revokeStoredClientToken(paths.store, "one"), ClientTokenLockBusyError);
    assert.equal(readFileSync(paths.store, "utf8"), before);
  });
});

function fakeRes() {
  const outcome: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      outcome.status = code;
      return res;
    },
    json(payload: unknown) {
      outcome.body = payload;
      return res;
    },
  };
  return { res, outcome };
}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: Request, res: Response) => void }[] };
}

function callRoute(deps: ClientTokensDeps, method: "get" | "delete", routePath: string, params: Record<string, string> = {}) {
  const router = createClientTokensRouter(deps) as unknown as { stack: RouteLayer[] };
  const layer = router.stack.find((candidate) => candidate.route?.path === routePath && candidate.route.methods[method] === true);
  const handle = layer?.route?.stack[0]?.handle;
  if (handle === undefined) throw new Error(`no ${method} ${routePath}`);
  const { res, outcome } = fakeRes();
  handle({ params } as unknown as Request, res as unknown as Response);
  return outcome;
}

describe("client tokens routes", () => {
  const listing = [{ name: "n8n", id: ID_A, createdAt: NOW, scopes: ["full" as const], lastUsedAt: null }];
  const deps = (revoke: ClientTokensDeps["revoke"]): ClientTokensDeps => ({ list: () => listing, revoke });

  it("lists the tokens", () => {
    assert.deepEqual(
      callRoute(
        deps(() => true),
        "get",
        API_ROUTES.config.clientTokens,
      ),
      { status: 200, body: { tokens: listing } },
    );
  });

  it("revokes by name, 404s an unknown one, 409s a held lock and 500s anything else", () => {
    assert.deepEqual(
      callRoute(
        deps(() => true),
        "delete",
        API_ROUTES.config.clientToken,
        { name: "n8n" },
      ),
      { status: 200, body: { revoked: "n8n" } },
    );
    assert.equal(
      callRoute(
        deps(() => false),
        "delete",
        API_ROUTES.config.clientToken,
        { name: "nope" },
      ).status,
      404,
    );
    const busy = (): boolean => {
      throw new ClientTokenLockBusyError("busy");
    };
    assert.equal(callRoute(deps(busy), "delete", API_ROUTES.config.clientToken, { name: "n8n" }).status, 409);
    const broken = (): boolean => {
      throw new Error("disk full");
    };
    assert.equal(callRoute(deps(broken), "delete", API_ROUTES.config.clientToken, { name: "n8n" }).status, 500);
  });
});

describe("client tokens through the host", () => {
  const state = { restoreHome: (): void => undefined, owner: "", client: "" };
  beforeEach(async () => {
    const home = makeTempDir("mulmo-client-token-host-");
    state.restoreHome = isolateHome(home);
    __resetForTests();
    state.owner = await generateAndWriteToken(path.join(home, ".session-token"));
    const issued = issue([], "n8n");
    writeClientTokenFile(clientTokensPath(), issued.records);
    state.client = issued.token;
  });
  afterEach(() => {
    state.restoreHome();
    __resetForTests();
  });

  it("a client token's use shows up as its last use; the owner's does not", () => {
    assert.equal(listStoredClientTokens()[0]?.lastUsedAt, null);
    resolveTokenPrincipal(state.owner);
    assert.equal(listStoredClientTokens()[0]?.lastUsedAt, null);
    resolveTokenPrincipal(state.client);
    assert.notEqual(listStoredClientTokens()[0]?.lastUsedAt, null);
    assert.equal(clientTokenUsagePath().startsWith(path.dirname(clientTokensPath())), true);
  });

  it("refuses the listing and the revoke to a client token", () => {
    ["GET", "DELETE"].forEach((method) => {
      const { res, outcome } = fakeRes();
      const routePath = method === "GET" ? "/config/client-tokens" : "/config/client-tokens/n8n";
      bearerAuth(
        { headers: { authorization: `Bearer ${state.client}` }, path: routePath, method } as unknown as Request,
        res as unknown as Response,
        () => undefined,
      );
      assert.equal(outcome.status, 403, method);
    });
  });
});
