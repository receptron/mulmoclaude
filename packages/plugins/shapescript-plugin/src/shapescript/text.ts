import * as THREE from "three";
import typeface from "./fonts/helvetiker_regular.typeface.json";

/** Text layout for the `text` command.
 *
 *  Upstream sets text in the system's Helvetica at point size 1: the first
 *  baseline at y = 0, the left margin at x = 0, one world unit per line. The
 *  bundled face is Helvetiker (MgOpen Moderna), a Helvetica look-alike in the
 *  three.js typeface format, scaled so its capitals are as tall as Helvetica's
 *  at that size. Glyph outlines become closed rings, grouped into shapes with
 *  holes, which builders fill or extrude and the scene draws as strokes. */

interface Glyph {
  /** Horizontal advance, in font units. */
  ha: number;
  /** Outline commands: `m x y`, `l x y`, `q x y cx cy`, `b x y c1x c1y c2x c2y`. */
  o?: string;
}

const glyphs = (typeface as unknown as { glyphs: Record<string, Glyph> }).glyphs;

/** Helvetica's cap height at point size 1, and the bundled face's in its own units. */
const CAP_HEIGHT = 0.718;
const FONT_CAP_UNITS = 1013;
const UNIT = CAP_HEIGHT / FONT_CAP_UNITS;
/** Upstream's default line height: one world unit, plus `linespacing`. */
const LINE_HEIGHT = 1;
const FALLBACK_GLYPH = "?";
/** Characters per `text`, bounding the layout work before the vertex budget applies. */
export const MAX_TEXT_LENGTH = 2000;
const DEGENERATE_RING_AREA = 1e-12;

export interface TextLayoutOptions {
  wrapWidth?: number;
  lineSpacing: number;
  /** Segments per outline curve. */
  curveSegments: number;
}

export interface TextLayout {
  /** Filled glyphs, with their holes. */
  shapes: THREE.Shape[];
  /** Every outline ring, for drawing the text as strokes. */
  rings: THREE.Vector2[][];
  /** Characters the bundled face lacks, drawn as `?`. */
  missing: string[];
}

/** A glyph's outline as closed rings in font units. */
function outlineOf(glyph: Glyph, curveSegments: number): THREE.Vector2[][] {
  if (!glyph.o) return [];
  const path = new THREE.ShapePath();
  const tokens = glyph.o.split(" ");
  let i = 0;
  const next = () => Number(tokens[i++]);
  while (i < tokens.length) {
    switch (tokens[i++]) {
      case "m":
        path.moveTo(next(), next());
        break;
      case "l":
        path.lineTo(next(), next());
        break;
      case "q": {
        const [x, y, cx, cy] = [next(), next(), next(), next()];
        path.quadraticCurveTo(cx, cy, x, y);
        break;
      }
      case "b": {
        const [x, y, c1x, c1y, c2x, c2y] = [next(), next(), next(), next(), next(), next()];
        path.bezierCurveTo(c1x, c1y, c2x, c2y, x, y);
        break;
      }
      default:
        break;
    }
  }
  return path.subPaths.map((sub) => closedRing(sub.getPoints(curveSegments)));
}

/** Drop a final point that repeats the first: rings are implicitly closed. */
function closedRing(points: THREE.Vector2[]): THREE.Vector2[] {
  const last = points[points.length - 1];
  return points.length > 1 && last && last.equals(points[0]!) ? points.slice(0, -1) : points;
}

function ringArea(ring: readonly THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!,
      b = ring[(i + 1) % ring.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function containsPoint(ring: readonly THREE.Vector2[], point: THREE.Vector2): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!,
      b = ring[j]!;
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Group closed rings into shapes: a ring inside an odd number of others is a
 *  hole of the innermost ring around it, any other ring is an outline. The
 *  rings' winding does not matter; the geometry classes normalise it. */
export function shapesFromRings(rings: readonly THREE.Vector2[][]): THREE.Shape[] {
  const usable = rings.filter((ring) => ring.length >= 3 && Math.abs(ringArea(ring)) > DEGENERATE_RING_AREA);
  const ancestors = usable.map((ring, i) => usable.flatMap((other, j) => (j !== i && containsPoint(other, ring[0]!) ? [j] : [])));
  const shapes = new Map<number, THREE.Shape>();
  ancestors.forEach((list, i) => {
    if (list.length % 2 === 0) shapes.set(i, new THREE.Shape(usable[i]));
  });
  ancestors.forEach((list, i) => {
    if (list.length % 2 === 0) return;
    // The innermost outline around this hole: the ancestor with one fewer ancestor.
    const outer = list.find((j) => ancestors[j]!.length === list.length - 1);
    if (outer !== undefined) shapes.get(outer)?.holes.push(new THREE.Path(usable[i]));
  });
  return [...shapes.values()];
}

const glyphFor = (char: string): Glyph | undefined => glyphs[char];

/** The advance of a string in world units. */
function widthOf(text: string): number {
  let width = 0;
  for (const char of text) width += (glyphFor(char) ?? glyphFor(FALLBACK_GLYPH))!.ha * UNIT;
  return width;
}

/** Greedy word wrap at `width` world units; a word wider than the width
 *  stands on its own line. */
function wrapLine(line: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && widthOf(candidate) > width) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines;
}

function placeRing(ring: readonly THREE.Vector2[], x: number, y: number): THREE.Vector2[] {
  return ring.map((point) => new THREE.Vector2(point.x * UNIT + x, point.y * UNIT + y));
}

/** Lay `text` out from the origin: left margin at x = 0, first baseline at
 *  y = 0, later lines below it. */
export function layoutText(text: string, options: TextLayoutOptions): TextLayout {
  const outlines = new Map<string, THREE.Vector2[][]>();
  const layout: TextLayout = { shapes: [], rings: [], missing: [] };
  const lines = text.split("\n").flatMap((line) => (options.wrapWidth === undefined ? [line] : wrapLine(line, options.wrapWidth)));
  lines.forEach((line, row) => {
    const y = -row * (LINE_HEIGHT + options.lineSpacing);
    let x = 0;
    for (const char of line) {
      let glyph = glyphFor(char);
      if (!glyph) {
        layout.missing.push(char);
        glyph = glyphFor(FALLBACK_GLYPH)!;
      }
      const key = glyph === glyphFor(char) ? char : FALLBACK_GLYPH;
      const outline = outlines.get(key) ?? outlineOf(glyph, options.curveSegments);
      outlines.set(key, outline);
      const rings = outline.map((ring) => placeRing(ring, x, y));
      layout.rings.push(...rings);
      layout.shapes.push(...shapesFromRings(rings));
      x += glyph.ha * UNIT;
    }
  });
  return layout;
}

/** The text of a `text` line: strings concatenate as written, other values
 *  print with a space between two of them (`text 1 2` is "1 2", `text 1 "" 2`
 *  is "12"), as upstream interpolates. */
export function interpolate(values: readonly unknown[], print: (value: unknown) => string): string {
  let out = "";
  let previousWasValue = false;
  for (const value of values) {
    if (typeof value === "string") {
      out += value;
      previousWasValue = false;
    } else {
      if (previousWasValue) out += " ";
      out += print(value);
      previousWasValue = true;
    }
  }
  return out;
}
