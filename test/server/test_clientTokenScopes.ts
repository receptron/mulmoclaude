// Client-token scopes (#3636): the pure rule `bearerAuth`, the collection list
// and the socket check share. Refusal is the expected answer for every doubt.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasFullScope,
  isClientTokenScope,
  isCollectionInScope,
  isValidScopeSet,
  isWithinClientTokenScopes,
  type ClientTokenScope,
} from "../../server/api/auth/clientTokenScope.js";

const READ_METHODS = ["GET", "HEAD"];
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

describe("isClientTokenScope", () => {
  ["full", "read", "collection:tasks", "collection:a", "collection:A-b_9"].forEach((value) => {
    it(`accepts ${value}`, () => assert.equal(isClientTokenScope(value), true));
  });

  [
    "",
    "Full",
    "READ",
    "write",
    "collection:",
    "collection:-x",
    "collection:x-",
    "collection:a/b",
    "collection:..",
    "collection:a b",
    "collections:tasks",
    " read",
    null,
    undefined,
    7,
    ["read"],
  ].forEach((value) => {
    it(`refuses ${JSON.stringify(value)}`, () => assert.equal(isClientTokenScope(value), false));
  });
});

describe("isValidScopeSet", () => {
  const valid: ClientTokenScope[][] = [["full"], ["read"], ["collection:a"], ["read", "collection:a", "collection:b"]];
  const invalid: ClientTokenScope[][] = [[], ["full", "read"], ["collection:a", "full"], ["full", "full"]];
  valid.forEach((scopes) => it(`accepts ${JSON.stringify(scopes)}`, () => assert.equal(isValidScopeSet(scopes), true)));
  invalid.forEach((scopes) => it(`refuses ${JSON.stringify(scopes)}`, () => assert.equal(isValidScopeSet(scopes), false)));
});

describe("isWithinClientTokenScopes — full", () => {
  it("passes every method on every path", () => {
    [...READ_METHODS, ...WRITE_METHODS].forEach((method) => {
      ["/collections/x", "/transports/discord/chat", "/files/write", "/anything"].forEach((path) => {
        assert.equal(isWithinClientTokenScopes(["full"], { method, path }), true, `${method} ${path}`);
      });
    });
  });

  it("is refused for an invalid set even if it names full", () => {
    assert.equal(isWithinClientTokenScopes(["full", "read"], { method: "GET", path: "/collections" }), false);
    assert.equal(isWithinClientTokenScopes([], { method: "GET", path: "/collections" }), false);
  });
});

describe("isWithinClientTokenScopes — read", () => {
  it("passes reads on any path", () => {
    READ_METHODS.forEach((method) => assert.equal(isWithinClientTokenScopes(["read"], { method, path: "/transports/x" }), true));
  });

  it("refuses every other method", () => {
    WRITE_METHODS.forEach((method) => assert.equal(isWithinClientTokenScopes(["read"], { method, path: "/collections/tasks" }), false, method));
  });

  it("does not treat a lowercase method as a read", () => {
    assert.equal(isWithinClientTokenScopes(["read"], { method: "get", path: "/collections" }), false);
  });
});

describe("isWithinClientTokenScopes — collection", () => {
  const tasks: ClientTokenScope[] = ["collection:tasks"];
  const within = (path: string, method = "GET", scopes: ClientTokenScope[] = tasks): boolean => isWithinClientTokenScopes(scopes, { method, path });

  it("passes every method under its collection", () => {
    ["/collections/tasks", "/collections/tasks/", "/collections/tasks/items", "/collections/tasks/items/abc", "/Collections/tasks/refresh"].forEach((path) => {
      [...READ_METHODS, ...WRITE_METHODS].forEach((method) => assert.equal(within(path, method), true, `${method} ${path}`));
    });
  });

  it("passes the collection list for reads only", () => {
    ["/collections", "/collections/"].forEach((path) => {
      READ_METHODS.forEach((method) => assert.equal(within(path, method), true, `${method} ${path}`));
      WRITE_METHODS.forEach((method) => assert.equal(within(path, method), false, `${method} ${path}`));
    });
  });

  it("refuses another collection, a differently cased slug, and the ontology", () => {
    [
      "/collections/notes",
      "/collections/Tasks",
      "/collections/TASKS/items",
      "/collections/tasksx",
      "/collections/task",
      "/collections/ontology",
      "/collections/Ontology",
    ].forEach((path) => assert.equal(within(path), false, path));
  });

  it("refuses a collection named ontology even when scoped to it", () => {
    assert.equal(within("/collections/ontology", "GET", ["collection:ontology"]), false);
  });

  it("refuses encoded and dotted tricks", () => {
    [
      "/collections/tasks%2F..%2Fnotes",
      "/collections/tasks%2Fitems",
      "/collections/%74asks/items",
      "/collections/tasks/../notes",
      "/collections/./tasks",
      "/collections/tasks/%2E%2E/notes",
      "/collections//tasks",
      "/collections/tasks/%E0%A4%A",
      "//collections/tasks",
    ].forEach((path) => {
      const expected = path === "/collections/%74asks/items";
      assert.equal(within(path), expected, path);
    });
  });

  it("refuses every path outside /collections", () => {
    ["/", "", "/transports/discord/chat", "/files/write", "/notifier", "/collections-registry", "/collectionsx/tasks", "/sessions"].forEach((path) =>
      assert.equal(within(path), false, path),
    );
  });

  it("combined with read, passes reads in its collection and refuses writes there", () => {
    const scopes: ClientTokenScope[] = ["read", "collection:tasks"];
    assert.equal(within("/collections/tasks/items", "GET", scopes), true);
    assert.equal(within("/collections/tasks/items", "POST", scopes), false);
    assert.equal(within("/collections/notes", "GET", scopes), false);
  });

  it("several collections are a union", () => {
    const scopes: ClientTokenScope[] = ["collection:tasks", "collection:notes"];
    assert.equal(within("/collections/notes/items", "POST", scopes), true);
    assert.equal(within("/collections/tasks", "GET", scopes), true);
    assert.equal(within("/collections/other", "GET", scopes), false);
  });
});

// Generated paths. The property: what Express would hand the handler as the
// slug — the second segment, decoded — is the token's own slug, or the request
// is a read of the bare list. No pass may break it.
describe("isWithinClientTokenScopes — generated paths", () => {
  const PIECES = ["collections", "Collections", "tasks", "Tasks", "notes", "ontology", "", ".", "..", "%2F", "%74asks", "%", "items", "x"];
  const SEED = 3636;
  const PATHS_TO_GENERATE = 5000;
  const MAX_SEGMENTS = 4;
  const LCG_MULTIPLIER = 1103515245;
  const LCG_INCREMENT = 12345;
  const LCG_MODULUS = 2 ** 31;

  function generatePaths(): string[] {
    const state = { value: SEED };
    const next = (bound: number): number => {
      state.value = (state.value * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
      return state.value % bound;
    };
    return Array.from({ length: PATHS_TO_GENERATE }, () => {
      const count = 1 + next(MAX_SEGMENTS);
      return `/${Array.from({ length: count }, () => PIECES[next(PIECES.length)]).join("/")}`;
    });
  }

  function slugHandedToHandler(path: string): string | undefined {
    const [, , segment] = path.split("/");
    return segment === undefined || segment === "" ? undefined : decodeURIComponent(segment);
  }

  it(`never passes a path outside its collection on ${PATHS_TO_GENERATE} generated paths (seed ${SEED})`, () => {
    const paths = generatePaths();
    const passes = paths.flatMap((path) =>
      ["GET", "POST"].filter((method) => isWithinClientTokenScopes(["collection:tasks"], { method, path })).map((method) => ({ method, path })),
    );
    const violations = passes.filter(({ method, path }) => {
      const slug = slugHandedToHandler(path);
      return slug === undefined ? method !== "GET" : slug !== "tasks";
    });
    assert.deepEqual(violations, []);
    assert.ok(passes.length > 0, "the generator reaches the allowed paths at all");
  });
});

describe("hasFullScope and isCollectionInScope", () => {
  it("only full is full", () => {
    assert.equal(hasFullScope(["full"]), true);
    assert.equal(hasFullScope(["read"]), false);
    assert.equal(hasFullScope(["read", "collection:a"]), false);
  });

  it("a token with no collection scope sees every collection; otherwise only its own", () => {
    assert.equal(isCollectionInScope(["full"], "any"), true);
    assert.equal(isCollectionInScope(["read"], "any"), true);
    assert.equal(isCollectionInScope(["collection:a"], "a"), true);
    assert.equal(isCollectionInScope(["collection:a"], "A"), false);
    assert.equal(isCollectionInScope(["collection:a", "collection:b"], "c"), false);
  });
});
