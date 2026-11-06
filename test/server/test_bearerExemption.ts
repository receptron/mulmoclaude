// Which `/api/*` requests skip the bearer check (#3628): only what a browser
// requests without a header. The file routes that write or start an OS
// handler must not be among them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isBearerExempt } from "../../server/api/auth/bearerExemption.js";
import { isViewDataPath } from "../../server/api/auth/viewToken.js";
import { API_ROUTES } from "../../src/config/apiRoutes.js";

const exempt = (method: string, path: string): boolean => isBearerExempt({ method, path }, isViewDataPath);
const mountRelative = (route: string): string => route.slice("/api".length);

describe("isBearerExempt — /files", () => {
  const readRoutes = [API_ROUTES.files.raw, API_ROUTES.files.content, API_ROUTES.files.tree, API_ROUTES.files.dir, API_ROUTES.files.refRoots];
  readRoutes.forEach((route) => {
    it(`lets GET and HEAD ${route} through without a token`, () => {
      assert.equal(exempt("GET", mountRelative(route)), true);
      assert.equal(exempt("HEAD", mountRelative(route)), true);
    });
  });

  const writeRequests: [string, string][] = [
    ["POST", API_ROUTES.files.create],
    ["POST", API_ROUTES.files.upload],
    ["PUT", API_ROUTES.files.content],
    ["POST", API_ROUTES.files.open],
    ["POST", API_ROUTES.files.reveal],
  ];
  writeRequests.forEach(([method, route]) => {
    it(`requires the token for ${method} ${route}`, () => assert.equal(exempt(method, mountRelative(route)), false));
  });

  it("requires the token for every non-read method under /files/", () => {
    ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "get", ""].forEach((method) => assert.equal(exempt(method, "/files/raw"), false, method));
  });

  it("does not exempt a path that only resembles /files/", () => {
    ["/files", "/filesx/raw", "/Files/raw", "/x/files/raw", "files/raw", ""].forEach((path) => assert.equal(exempt("GET", path), false, path));
  });
});

describe("isBearerExempt — the other exemptions", () => {
  it("defers custom-view data paths to the matcher it is given, for any method", () => {
    assert.equal(
      isBearerExempt({ method: "POST", path: "/anything" }, () => true),
      true,
    );
    assert.equal(
      isBearerExempt({ method: "GET", path: "/anything" }, () => false),
      false,
    );
  });

  it("lets GET and HEAD runtime-plugin assets through, and nothing shorter or written", () => {
    assert.equal(exempt("GET", "/plugins/runtime/pkg/1.0.0/dist/vue.js"), true);
    assert.equal(exempt("HEAD", "/plugins/runtime/pkg/1.0.0/dist/vue.js"), true);
    assert.equal(exempt("POST", "/plugins/runtime/pkg/1.0.0/dist/vue.js"), false);
    assert.equal(exempt("GET", "/plugins/runtime/list"), false);
    assert.equal(exempt("POST", "/plugins/runtime/pkg/dispatch"), false);
  });

  it("lets only GET reach the runtime-plugin OAuth callback", () => {
    assert.equal(exempt("GET", "/plugins/runtime/oauth-callback/alias"), true);
    assert.equal(exempt("HEAD", "/plugins/runtime/oauth-callback/alias"), false);
    assert.equal(exempt("POST", "/plugins/runtime/oauth-callback/alias"), false);
  });

  it("requires the token everywhere else", () => {
    ["/agent", "/config", "/sessions", "/collections/x", "/", ""].forEach((path) => assert.equal(exempt("GET", path), false, path));
  });
});
