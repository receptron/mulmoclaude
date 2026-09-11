import * as THREE from "three";
import { ConvexGeometry } from "three/examples/jsm/geometries/ConvexGeometry.js";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** How far a vertex may sit outside a face plane and the mesh still count as convex. */
const CONVEX_EPSILON = 1e-6;
/** Face-plane checks stop at this many comparisons; a bigger mesh is treated as non-convex. */
const MAX_CONVEXITY_CHECKS = 4_000_000;
/** The most faces a non-convex operand may contribute pieces for. */
export const MAX_MINKOWSKI_PIECES = 2048;
/** The most points one hull may be built from. */
export const MAX_HULL_POINTS = 400_000;

const keyOf = (point: THREE.Vector3): string => `${Math.round(point.x * 1e6)},${Math.round(point.y * 1e6)},${Math.round(point.z * 1e6)}`;

/** The distinct vertex positions of a geometry, in world space. */
export function uniquePoints(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.Vector3[] {
  const position = geometry.getAttribute("position");
  const seen = new Set<string>();
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < position.count; i++) {
    const point = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(matrix);
    const key = keyOf(point);
    if (seen.has(key)) continue;
    seen.add(key);
    points.push(point);
  }
  return points;
}

/** The triangles of a geometry as world-space corner triples. */
export function worldTriangles(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.Vector3[][] {
  const position = geometry.getAttribute("position");
  const index = geometry.index;
  const count = index?.count ?? position.count;
  const triangles: THREE.Vector3[][] = [];
  for (let i = 0; i + 2 < count; i += 3) {
    triangles.push([0, 1, 2].map((j) => new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(i + j) : i + j).applyMatrix4(matrix)));
  }
  return triangles;
}

/** +1 when the triangles wind outward, −1 when a mirroring `size` or `scale`
 *  turned them inside out — the sign of the enclosed volume. */
export function windingSign(triangles: readonly THREE.Vector3[][]): number {
  let volume = 0;
  for (const [a, b, c] of triangles) volume += a!.dot(b!.clone().cross(c!));
  return volume < 0 ? -1 : 1;
}

/** Whether every vertex lies on or behind every face plane: a convex solid,
 *  however its faces wind, whose Minkowski sum with another convex solid is
 *  the hull of their pairwise vertex sums. */
export function isConvex(triangles: readonly THREE.Vector3[][], points: readonly THREE.Vector3[]): boolean {
  if (triangles.length * points.length > MAX_CONVEXITY_CHECKS) return false;
  const sign = windingSign(triangles);
  const normal = new THREE.Vector3();
  for (const [a, b, c] of triangles) {
    normal.crossVectors(b!.clone().sub(a!), c!.clone().sub(a!)).multiplyScalar(sign);
    if (normal.lengthSq() < 1e-18) continue;
    normal.normalize();
    const offset = normal.dot(a!);
    for (const point of points) if (normal.dot(point) - offset > CONVEX_EPSILON) return false;
  }
  return true;
}

/** The convex hull of `points`. A whole sum (`smooth`) is the rounded solid
 *  itself, so shared vertices average their face normals. A per-face PIECE
 *  keeps flat normals: its rounded sides are interior once the pieces overlap,
 *  and averaging them into its flat top tilted that face's border — a visible
 *  bump along every seam of a flat face. Coplanar points (two parallel faces
 *  summed) give a flat sliver rather than a throw from `ConvexGeometry`; that
 *  is `undefined` here. */
export function hullGeometry(points: THREE.Vector3[], smooth: boolean): THREE.BufferGeometry | undefined {
  if (points.length > MAX_HULL_POINTS) throw new Error("`minkowski` operands are too detailed — lower `detail` or simplify the shapes");
  const hull = new ConvexGeometry(points);
  hull.deleteAttribute("normal");
  hull.deleteAttribute("uv");
  const geometry = smooth ? mergeVertices(hull, 1e-6) : hull;
  if (smooth) hull.dispose();
  if (!geometry.getAttribute("position")?.count || isFlat(geometry)) {
    geometry.dispose();
    return undefined;
  }
  geometry.computeVertexNormals();
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute("position").count * 2), 2));
  return geometry;
}

/** A hull encloses nothing when its volume is negligible AT ITS OWN SCALE: a
 *  sum of two 1e-5 cubes is a solid of 8e-15, a sum of two parallel faces is
 *  flat however large. */
const FLAT_VOLUME_RATIO = 1e-9;

function isFlat(geometry: THREE.BufferGeometry): boolean {
  geometry.computeBoundingBox();
  const size = geometry.boundingBox!.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.y, size.z);
  return extent === 0 || Math.abs(enclosedVolume(geometry)) < FLAT_VOLUME_RATIO * extent ** 3;
}

function enclosedVolume(geometry: THREE.BufferGeometry): number {
  let volume = 0;
  for (const [a, b, c] of worldTriangles(geometry, new THREE.Matrix4())) volume += a!.dot(b!.clone().cross(c!)) / 6;
  return volume;
}

export interface MinkowskiOperand {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
}

/** `a ⊕ b`. Two convex solids sum to one hull; when one is not convex, every
 *  face of it is summed with the other on its own and the pieces are merged
 *  (their union), as upstream decomposes it. */
export function minkowskiSum(a: MinkowskiOperand, b: MinkowskiOperand): THREE.BufferGeometry {
  const facesA = worldTriangles(a.geometry, a.matrix);
  const facesB = worldTriangles(b.geometry, b.matrix);
  const pointsA = uniquePoints(a.geometry, a.matrix);
  const pointsB = uniquePoints(b.geometry, b.matrix);
  if (facesA.length === 0 || facesB.length === 0) throw new Error("`minkowski` needs solid operands");
  const convexA = isConvex(facesA, pointsA);
  const convexB = isConvex(facesB, pointsB);
  if (convexA && convexB) {
    const hull = hullGeometry(pairwiseSums(pointsA, pointsB), true);
    if (!hull) throw new Error("`minkowski` operands must enclose a volume");
    return hull;
  }
  // Sum the non-convex operand's faces with the whole of the other when that
  // one is convex; otherwise pair faces with faces.
  const [faces, other] = convexB ? [facesA, [pointsB]] : convexA ? [facesB, [pointsA]] : [facesA, facesB];
  if (faces.length * other.length > MAX_MINKOWSKI_PIECES) {
    throw new Error(`\`minkowski\` of non-convex shapes is limited to ${MAX_MINKOWSKI_PIECES} face pairs — lower \`detail\` or make the operands convex`);
  }
  // A flat pair (two parallel faces) adds nothing to the union and is skipped.
  const pieces: THREE.BufferGeometry[] = [];
  for (const face of faces)
    for (const corners of other) {
      const piece = hullGeometry(pairwiseSums(face, corners), false);
      if (piece) pieces.push(piece);
    }
  if (pieces.length === 0) throw new Error("`minkowski` operands must enclose a volume");
  const merged = pieces.length === 1 ? pieces[0]! : mergeGeometries(pieces);
  if (pieces.length > 1) pieces.forEach((piece) => piece.dispose());
  if (!merged) throw new Error("Could not combine the `minkowski` pieces");
  return merged;
}

function pairwiseSums(a: readonly THREE.Vector3[], b: readonly THREE.Vector3[]): THREE.Vector3[] {
  if (a.length * b.length > MAX_HULL_POINTS) throw new Error("`minkowski` operands are too detailed — lower `detail` or simplify the shapes");
  const sums: THREE.Vector3[] = [];
  for (const p of a) for (const q of b) sums.push(p.clone().add(q));
  return sums;
}

/** Every face moved inward by `distance` (outward when negative): each vertex
 *  slides to where its faces' offset planes meet — exact at any corner where
 *  the planes are consistent, least-squares where more than three meet. */
export function insetGeometry(geometry: THREE.BufferGeometry, distance: number): THREE.BufferGeometry {
  const position = geometry.getAttribute("position");
  const triangles = worldTriangles(geometry, new THREE.Matrix4());
  const { normalsAt, onEdge } = faceNormalsAtVertices(triangles);
  const movedTo = new Map<string, THREE.Vector3>();
  const cornerMoved = (point: THREE.Vector3): THREE.Vector3 => {
    const key = keyOf(point);
    let moved = movedTo.get(key);
    if (!moved) {
      moved = point.clone().addScaledVector(offsetDirection(normalsAt.get(key) ?? []), -distance);
      movedTo.set(key, moved);
    }
    return moved;
  };
  // A vertex on another face's edge lands on that edge's inset — between its
  // moved ends, at the same fraction — rather than at its own planes' corner,
  // which can lie beyond the moved corner when the vertex is nearer to it
  // than the inset distance.
  const moved = geometry.clone();
  const target = moved.getAttribute("position") as THREE.BufferAttribute;
  const point = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i);
    const edge = onEdge.get(keyOf(point));
    const placed = edge ? cornerMoved(edge.from).clone().lerp(cornerMoved(edge.to), edge.t) : cornerMoved(point);
    target.setXYZ(i, placed.x, placed.y, placed.z);
  }
  target.needsUpdate = true;
  moved.computeBoundingBox();
  moved.computeBoundingSphere();
  return moved;
}

/** The distinct face normals meeting at each vertex position. A vertex that
 *  sits on another triangle's EDGE without being one of its corners — the
 *  T-junctions a boolean leaves where one face was split by a seam and its
 *  neighbour was not — belongs to that face too; without it the vertex would
 *  slide along one face alone and stand proud of the inset surface. */
interface EdgePlace {
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
}

function faceNormalsAtVertices(triangles: readonly THREE.Vector3[][]): { normalsAt: Map<string, THREE.Vector3[]>; onEdge: Map<string, EdgePlace> } {
  const normalsAt = new Map<string, THREE.Vector3[]>();
  const onEdge = new Map<string, EdgePlace>();
  const add = (point: THREE.Vector3, normal: THREE.Vector3) => {
    const key = keyOf(point);
    const normals = normalsAt.get(key) ?? [];
    if (!normals.some((known) => known.dot(normal) > 1 - 1e-6)) normals.push(normal);
    normalsAt.set(key, normals);
  };
  // Outward whichever way the faces wind, so a mirrored mesh insets inward too.
  const sign = windingSign(triangles);
  const normals = triangles.map(([a, b, c]) => {
    const normal = new THREE.Vector3().crossVectors(b!.clone().sub(a!), c!.clone().sub(a!)).multiplyScalar(sign);
    return normal.lengthSq() < 1e-18 ? undefined : normal.normalize();
  });
  triangles.forEach((corners, i) => {
    const normal = normals[i];
    if (normal) for (const corner of corners) add(corner, normal);
  });
  const grid = new VertexGrid(triangles.flat());
  triangles.forEach((corners, i) => {
    const normal = normals[i];
    if (!normal) return;
    for (let e = 0; e < 3; e++) {
      const from = corners[e]!,
        to = corners[(e + 1) % 3]!;
      for (const point of grid.near(from, to)) {
        const t = onOpenSegment(point, from, to);
        if (t === undefined) continue;
        add(point, normal);
        if (!onEdge.has(keyOf(point))) onEdge.set(keyOf(point), { from, to, t });
      }
    }
  });
  return { normalsAt, onEdge };
}

const ON_EDGE_EPSILON = 1e-6;

/** Where along the segment `point` lies, when it lies strictly between the ends. */
function onOpenSegment(point: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3): number | undefined {
  const edge = to.clone().sub(from);
  const length = edge.length();
  if (length < ON_EDGE_EPSILON) return undefined;
  const t = point.clone().sub(from).dot(edge) / (length * length);
  if (t <= ON_EDGE_EPSILON || t >= 1 - ON_EDGE_EPSILON) return undefined;
  return point.distanceTo(from.clone().addScaledVector(edge, t)) < ON_EDGE_EPSILON * Math.max(1, length) ? t : undefined;
}

/** Distinct vertex positions bucketed on a uniform grid, so an edge is tested
 *  only against the vertices near it rather than all of them. */
class VertexGrid {
  private readonly cells = new Map<string, THREE.Vector3[]>();
  private readonly cell: number;
  private readonly origin: THREE.Vector3;

  constructor(points: readonly THREE.Vector3[]) {
    const box = new THREE.Box3().setFromPoints([...points]);
    this.origin = box.min.clone();
    const extent = box.getSize(new THREE.Vector3());
    this.cell = Math.max(extent.x, extent.y, extent.z, 1e-9) / VERTEX_GRID_DIVISIONS;
    const seen = new Set<string>();
    for (const point of points) {
      const key = keyOf(point);
      if (seen.has(key)) continue;
      seen.add(key);
      const cell = this.cellOf(point);
      const bucket = this.cells.get(cell) ?? [];
      bucket.push(point);
      this.cells.set(cell, bucket);
    }
  }

  private coordinates(point: THREE.Vector3): [number, number, number] {
    return [Math.floor((point.x - this.origin.x) / this.cell), Math.floor((point.y - this.origin.y) / this.cell), Math.floor((point.z - this.origin.z) / this.cell)];
  }

  private cellOf(point: THREE.Vector3): string {
    return this.coordinates(point).join(",");
  }

  /** The vertices in every cell the box around `from`–`to` touches. */
  near(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] {
    const [ax, ay, az] = this.coordinates(from);
    const [bx, by, bz] = this.coordinates(to);
    const found: THREE.Vector3[] = [];
    for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) {
      for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) {
        for (let z = Math.min(az, bz); z <= Math.max(az, bz); z++) found.push(...(this.cells.get(`${x},${y},${z}`) ?? []));
      }
    }
    return found;
  }
}

const VERTEX_GRID_DIVISIONS = 32;

/** Offsets sharper than this are clamped: a needle-like corner would otherwise
 *  shoot its vertex far past the shape. */
const MAX_OFFSET = 16;

/** The direction `d` with `d · n = 1` for every face normal `n` at a vertex —
 *  the corner of the unit-offset planes — by ridge-regularised least squares,
 *  so a single face gives its normal and two faces the point on their bisector. */
function offsetDirection(normals: readonly THREE.Vector3[]): THREE.Vector3 {
  if (normals.length === 0) return new THREE.Vector3();
  const ridge = 1e-9;
  const m = [ridge, 0, 0, 0, ridge, 0, 0, 0, ridge];
  const rhs = [0, 0, 0];
  for (const n of normals) {
    const c = [n.x, n.y, n.z];
    for (let r = 0; r < 3; r++) {
      rhs[r]! += c[r]!;
      for (let k = 0; k < 3; k++) m[r * 3 + k]! += c[r]! * c[k]!;
    }
  }
  const solved = new THREE.Vector3(...rhs).applyMatrix3(new THREE.Matrix3().fromArray(m).invert());
  return solved.length() > MAX_OFFSET ? solved.setLength(MAX_OFFSET) : solved;
}
