// Maps and 3D are loaded only for a chart that uses them. These pin what counts as
// using them, that the bundled maps are whole and register, and what the server checks.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUNDLED_MAPS, loadMaps, neededExtensions, needsBrowser, settleAll } from "../../../packages/plugins/chart-plugin/src/core/extensions";
import { echarts } from "../../../packages/plugins/chart-plugin/src/core/charting";
import { executeChart } from "../../../packages/plugins/chart-plugin/src/core/plugin";
import world from "../../../packages/plugins/chart-plugin/src/maps/world.json";
import japan from "../../../packages/plugins/chart-plugin/src/maps/japan.json";
import { memoryArtifacts } from "./memoryArtifacts";

const JAPAN_PREFECTURES = 47;

describe("neededExtensions", () => {
  it("needs nothing for a plain chart", () => {
    assert.deepEqual(neededExtensions({ xAxis: {}, yAxis: {}, series: [{ type: "bar" }] }), { gl: false, maps: [] });
  });

  it("finds echarts-gl by its series and by its components", () => {
    assert.equal(neededExtensions({ series: [{ type: "scatter3D" }] }).gl, true);
    assert.equal(neededExtensions({ series: { type: "surface" } }).gl, true);
    assert.equal(neededExtensions({ grid3D: {}, series: [] }).gl, true);
    assert.equal(neededExtensions({ globe: {} }).gl, true);
    assert.equal(neededExtensions({ series: [{ type: "scatter" }] }).gl, false);
  });

  it("finds bundled maps on map series, geo and geo3D, once each, and ignores others", () => {
    const option = {
      geo: { map: "world" },
      geo3D: { map: "japan-ja" },
      series: [
        { type: "map", map: "world" },
        { type: "map", map: "atlantis" },
        { type: "scatter", map: "japan" },
      ],
    };
    assert.deepEqual(neededExtensions(option).maps, ["world", "japan", "japan-ja"]);
  });

  it("looks into a timeline's baseOption and options", () => {
    const option = { baseOption: { geo: { map: "japan" } }, options: [{ series: [{ type: "bar3D" }] }] };
    assert.deepEqual(neededExtensions(option), { gl: true, maps: ["japan"] });
  });

  it("says only 3D needs a browser", () => {
    assert.equal(needsBrowser({ gl: true, maps: [] }), true);
    assert.equal(needsBrowser({ gl: false, maps: ["world"] }), false);
  });
});

/** Every coordinate of a geometry, however deeply nested. */
function points(value: unknown): unknown[] {
  if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "number")) return [value];
  return Array.isArray(value) ? value.flatMap(points) : [value];
}

describe("bundled maps", () => {
  const files: [string, { features: { type: string; properties: { name: string; name_ja: string }; geometry: { type: string; coordinates: unknown } }[] }][] = [
    ["world", world],
    ["japan", japan],
  ];

  for (const [name, file] of files) {
    it(`${name}: every feature is a named polygon of numeric points, names unique in both languages`, () => {
      file.features.forEach((feature) => {
        assert.equal(feature.type, "Feature");
        assert.ok(feature.properties.name.length > 0 && feature.properties.name_ja.length > 0, JSON.stringify(feature.properties));
        assert.ok(["Polygon", "MultiPolygon"].includes(feature.geometry.type));
        const all = points(feature.geometry.coordinates);
        assert.ok(all.length > 3);
        all.forEach((point) =>
          assert.ok(Array.isArray(point) && point.every((part) => Number.isFinite(part)), `${feature.properties.name}: ${JSON.stringify(point)}`),
        );
      });
      ["name", "name_ja"].forEach((key) => {
        const names = file.features.map((feature) => (key === "name" ? feature.properties.name : feature.properties.name_ja));
        assert.equal(new Set(names).size, names.length, `${key} repeats`);
      });
    });
  }

  it("japan holds the 47 prefectures, English names plain ASCII", () => {
    assert.equal(japan.features.length, JAPAN_PREFECTURES);
    const names = japan.features.map((feature) => feature.properties.name);
    ["Tokyo", "Osaka", "Hokkaido", "Oita", "Kochi", "Hyogo", "Okinawa"].forEach((name) => assert.ok(names.includes(name), name));
    names.forEach((name) => assert.match(name, /^[A-Za-z -]+$/));
    assert.ok(japan.features.some((feature) => feature.properties.name_ja === "東京都"));
  });

  it("world names Japan in both languages", () => {
    assert.ok(world.features.some((feature) => feature.properties.name === "Japan" && feature.properties.name_ja === "日本"));
  });

  it("registers each map once, Japanese names under -ja", async () => {
    await loadMaps([...BUNDLED_MAPS]);
    await loadMaps(["japan"]);
    BUNDLED_MAPS.forEach((map) => assert.ok(echarts.getMap(map), map));
    const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 600, height: 600 });
    try {
      chart.setOption({ series: [{ type: "map", map: "japan-ja", data: [{ name: "東京都", value: 5 }] }] });
      const svg = chart.renderToSVGString();
      assert.ok(svg.length > 1000);
    } finally {
      chart.dispose();
    }
  });
});

describe("executeChart with extensions", () => {
  it("draws a map chart on the server after loading its map", async () => {
    const option = { series: [{ type: "map", map: "world-ja", data: [{ name: "日本", value: 1 }] }] };
    const result = await executeChart({ files: { artifacts: memoryArtifacts() } }, { document: { charts: [{ option }] } });
    assert.ok(result.data, result.message);
  });

  it("refuses a word cloud, which this plugin does not load", async () => {
    const wordCloud = { option: { series: [{ type: "wordCloud", data: [{ name: "a", value: 3 }] }] } };
    const refused = await executeChart({ files: { artifacts: memoryArtifacts() } }, { document: { charts: [wordCloud] } });
    assert.equal(refused.data, undefined);
    assert.match(refused.message ?? "", /wordCloud/);
  });

  it("saves a 3D chart without a trial draw, but still checks its formats", async () => {
    const scatter3D = { grid3D: {}, xAxis3D: {}, yAxis3D: {}, zAxis3D: {}, series: [{ type: "scatter3D", data: [[1, 2, 3]] }] };
    const saved = await executeChart({ files: { artifacts: memoryArtifacts() } }, { document: { charts: [{ option: scatter3D }] } });
    assert.ok(saved.data, saved.message);
    const badFormat = { option: { ...scatter3D, series: [{ type: "scatter3D", label: { formatter: { kind: "money" } } }] } };
    const refused = await executeChart({ files: { artifacts: memoryArtifacts() } }, { document: { charts: [badFormat] } });
    assert.match(refused.message ?? "", /Invalid format/);
  });

  it("still refuses a map that is not bundled", async () => {
    const option = { series: [{ type: "map", map: "atlantis" }] };
    const result = await executeChart({ files: { artifacts: memoryArtifacts() } }, { document: { charts: [{ option }] } });
    assert.match(result.message ?? "", /No map named "atlantis"/);
  });
});

describe("settleAll", () => {
  it("waits for a slow load before failing with a fast one's error", async () => {
    const finished: string[] = [];
    const slow = new Promise<void>((resolve) =>
      setTimeout(() => {
        finished.push("map");
        resolve();
      }),
    );
    const fast = Promise.reject(new Error("gl failed"));
    await assert.rejects(settleAll([slow, fast]), /gl failed/);
    assert.deepEqual(finished, ["map"]);
  });

  it("resolves when every load does, and wraps a non-Error failure", async () => {
    await settleAll([Promise.resolve(1), Promise.resolve()]);
    const nonErrorReason: unknown = "offline";
    await assert.rejects(settleAll([Promise.reject(nonErrorReason)]), (error: unknown) => error instanceof Error && error.message === "offline");
  });
});
