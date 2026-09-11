// The two decisions the restart supervisor makes, separated from the socket so
// they can be checked without one (#3078 A-3).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, credentialsChanged, type Credentials } from "../src/supervisor.js";

const current: Credentials = { apiUrl: "http://127.0.0.1:3001", token: "token-1" };

describe("credentialsChanged", () => {
  it("is false for the same pair — the socket must not be replaced", () => {
    assert.equal(credentialsChanged(current, { ...current }), false);
  });

  it("is false when the workspace has published nothing yet", () => {
    // Mid-restart the sidecars are gone. That is not a new generation, it is
    // the absence of one, and rebuilding against it would aim at the fallback.
    assert.equal(credentialsChanged(current, null), false);
  });

  it("is true when the port moved", () => {
    assert.equal(credentialsChanged(current, { ...current, apiUrl: "http://127.0.0.1:3002" }), true);
  });

  it("is true when the token moved", () => {
    assert.equal(credentialsChanged(current, { ...current, token: "token-2" }), true);
  });

  it("is true when both moved", () => {
    assert.equal(credentialsChanged(current, { apiUrl: "http://127.0.0.1:3002", token: "token-2" }), true);
  });
});

describe("backoffMs", () => {
  it("starts fast — a restart takes seconds, not minutes", () => {
    assert.equal(backoffMs(0), 500);
  });

  it("treats a negative attempt as the first one", () => {
    assert.equal(backoffMs(-1), 500);
  });

  it("never decreases", () => {
    const series = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(backoffMs);
    series.forEach((value, index) => {
      if (index > 0) assert.ok(value >= series[index - 1], `attempt ${index} waited less than ${index - 1}`);
    });
  });

  it("caps, so a server down for the afternoon is not stat-ed twice a second forever", () => {
    assert.equal(backoffMs(20), 30_000);
    assert.equal(backoffMs(1000), 30_000);
  });
});
