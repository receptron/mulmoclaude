// The view-token mint route's response contract behind its deps seam: the
// minted token, capabilities clamped to the view's declaration, and the
// schema-derived `fields` a custom view receives as `__MC_VIEW.fields`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Request, Response } from "express";

import { rememberRequestPrincipal } from "../../../server/api/auth/principal.js";
import { createViewTokenHandler, type ViewTokenDeps } from "../../../server/api/routes/collections.js";
import type { LoadedCollection } from "../../../server/workspace/collections/index.js";

type Schema = LoadedCollection["schema"];

const FIXED_EXP = 1_700_000_000_000;

const schema = {
  title: "Tickets",
  icon: "list",
  dataPath: "data/tickets/items",
  primaryKey: "id",
  fields: {
    id: { type: "string", label: "ID", primary: true },
    status: { type: "enum", label: "Status", values: ["要レビュー", "確認済み", "保留"] },
    clientId: { type: "ref", label: "Client", to: "clients" },
    lines: { type: "table", label: "Lines", of: { kind: { type: "enum", label: "Kind", values: ["a", "b"] } } },
  },
  views: [
    { id: "board", label: "Board", file: "views/board.html", capabilities: ["read"] },
    { id: "editor", label: "Editor", file: "views/editor.html", capabilities: ["read", "write"] },
  ],
} as unknown as Schema;

const collection = { slug: "tickets", source: "project", schema, dataDir: "/d/tickets", skillDir: "/s/tickets" } as unknown as LoadedCollection;

function fakeReq(slug: string, body: unknown): Request<{ slug: string }> {
  return { params: { slug }, body } as unknown as Request<{ slug: string }>;
}

function fakeRes() {
  let statusCode = 200;
  let body: unknown;
  const res = {
    status: (code: number) => {
      statusCode = code;
      return res;
    },
    json: (payload: unknown) => {
      body = payload;
      return res;
    },
  } as unknown as Response;
  return { res, status: () => statusCode, body: () => body as Record<string, unknown> | undefined };
}

function deps(overrides: Partial<ViewTokenDeps> = {}): ViewTokenDeps {
  return {
    loadCollection: async (slug) => (slug === "tickets" ? collection : null),
    mint: (slug, caps) => ({ token: `tok:${slug}:${caps.join("+")}`, exp: FIXED_EXP }),
    ...overrides,
  };
}

async function mint(slug: string, body: unknown, override: Partial<ViewTokenDeps> = {}) {
  const { res, status, body: responseBody } = fakeRes();
  await createViewTokenHandler(deps(override))(fakeReq(slug, body), res);
  return { status: status(), body: responseBody() };
}

describe("createViewTokenHandler", () => {
  it("returns the token, data URL, clamped capabilities and the schema's top-level enum fields", async () => {
    const { status, body } = await mint("tickets", { viewId: "board" });
    assert.equal(status, 200);
    assert.deepEqual(body, {
      token: "tok:tickets:read",
      exp: FIXED_EXP,
      dataUrl: "/api/collections/tickets/view-data",
      capabilities: ["read"],
      fields: { status: { type: "enum", values: ["要レビュー", "確認済み", "保留"] } },
    });
  });

  it("returns an empty fields object for a schema with no enum fields", async () => {
    const plain = { ...collection, schema: { ...schema, fields: { id: { type: "string", label: "ID", primary: true } } } } as unknown as LoadedCollection;
    const { status, body } = await mint("tickets", { viewId: "board" }, { loadCollection: async () => plain });
    assert.equal(status, 200);
    assert.deepEqual(body?.fields, {});
  });

  it("never grants a capability the view did not declare", async () => {
    const { body } = await mint("tickets", { viewId: "board", capabilities: ["read", "write"] });
    assert.deepEqual(body?.capabilities, ["read"]);
    const editor = await mint("tickets", { viewId: "editor", capabilities: ["write"] });
    assert.deepEqual(editor.body?.capabilities, ["write"]);
  });

  it("400s a missing viewId, 404s an unknown collection or view, 500s when minting is unavailable", async () => {
    assert.equal((await mint("tickets", {})).status, 400);
    assert.equal((await mint("ghost", { viewId: "board" })).status, 404);
    assert.equal((await mint("tickets", { viewId: "nope" })).status, 404);
    assert.equal((await mint("tickets", { viewId: "board" }, { mint: () => null })).status, 500);
  });

  it("403s a client-token request before minting anything", async () => {
    const minted: string[] = [];
    const req = fakeReq("tickets", { viewId: "board" });
    rememberRequestPrincipal(req, { kind: "client", id: "c1", name: "phone", scopes: [] });
    const { res, status } = fakeRes();
    const recordMint: ViewTokenDeps["mint"] = (slug) => {
      minted.push(slug);
      return null;
    };
    await createViewTokenHandler(deps({ mint: recordMint }))(req, res);
    assert.equal(status(), 403);
    assert.deepEqual(minted, []);
  });
});
