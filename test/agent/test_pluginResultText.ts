import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_PLUGIN_RESULT_TEXT, pluginResultText } from "../../server/agent/pluginResultText.ts";

describe("pluginResultText", () => {
  it("joins message and instructions when set", () => {
    assert.equal(pluginResultText({ message: "saved", instructions: "tell the user" }), "saved\ntell the user");
    assert.equal(pluginResultText({ message: "saved", data: { big: true } }), "saved");
    assert.equal(pluginResultText({ instructions: "retry", ok: false }), "retry");
  });

  it("returns a narrate-only plain-JSON result as JSON instead of Done", () => {
    const status = { ok: true, linked: false, clientSecret: true, guidance: "Link your account." };
    assert.deepEqual(JSON.parse(pluginResultText(status)), status);
    const calendars = { ok: true, calendars: [{ id: "primary", summary: "Me" }] };
    assert.deepEqual(JSON.parse(pluginResultText(calendars)), calendars);
    assert.equal(pluginResultText({ ok: true }), '{"ok":true}');
    assert.equal(pluginResultText({ error: "bad kind" }), '{"error":"bad kind"}');
  });

  it("keeps Done for an empty envelope and for a rendered card without text", () => {
    assert.equal(pluginResultText({}), EMPTY_PLUGIN_RESULT_TEXT);
    assert.equal(pluginResultText({ data: { image: "x".repeat(100) }, title: "t" }), EMPTY_PLUGIN_RESULT_TEXT);
    assert.equal(pluginResultText({ data: null }), EMPTY_PLUGIN_RESULT_TEXT);
  });

  it("treats empty or falsy message / instructions as absent", () => {
    assert.equal(pluginResultText({ message: "", instructions: "" }), '{"message":"","instructions":""}');
    assert.equal(pluginResultText({ message: "", ok: true }), '{"message":"","ok":true}');
    assert.equal(pluginResultText({ message: undefined }), EMPTY_PLUGIN_RESULT_TEXT);
    assert.equal(pluginResultText({ message: "", data: {} }), EMPTY_PLUGIN_RESULT_TEXT);
  });
});
