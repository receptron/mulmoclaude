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

/** Whether every vertex lies on or behind every face plane: a convex solid
 *  (faces wound outward), whose Minkowski sum with another convex solid is the
 *  hull of their pairwise vertex sums. */
export function isConvex(triangles: readonly THREE.Vector3[][], points: readonly THREE.Vector3[]): boolean {
  if (triangles.length * points.length > MAX_CONVEXITY_CHECKS) return false;
  const normal = new THREE.Vector3();
  for (const [a, b, c] of triangles) {
    normal.crossVectors(b!.clone().sub(a!), c!.clone().sub(a!));
    if (normal.lengthSq() < 1e-18) continue;
    normal.normalize();
    const offset = normal.dot(a!);
    for (const point of points) if (normal.dot(point) - offset > CONVEX_EPSILON) return false;
  }
  return true;
}

/** The convex hull of `points`, smooth-shaded: it is the rounded part of a
 *  Minkowski sum, so shared vertices average their face normals. */
export function smoothHull(points: THREE.Vector3[]): THREE.BufferGeometry {
  if (points.length > MAX_HULL_POINTS) throw new Error("`minkowski` operands are too detailed — lower `detail` or simplify the shapes");
  const hull = new ConvexGeometry(points);
  hull.deleteAttribute("normal");
  hull.deleteAttribute("uv");
  const merged = mergeVertices(hull, 1e-6);
  hull.dispose();
  if (!merged.getAttribute("position")?.count) {
    merged.dispose();
    throw new Error("`minkowski` operands must enclose a volume");
  }
  merged.computeVertexNormals();
  merged.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(merged.getAttribute("position").count * 2), 2));
  return merged;
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
  if (convexA && convexB) return smoothHull(pairwiseSums(pointsA, pointsB));
  // Sum the non-convex operand's faces with the whole of the other when that
  // one is convex; otherwise pair faces with faces.
  const [faces, other] = convexB ? [facesA, [pointsB]] : convexA ? [facesB, [pointsA]] : [facesA, facesB];
  if (faces.length * other.length > MAX_MINKOWSKI_PIECES) {
    throw new Error(`\`minkowski\` of non-convex shapes is limited to ${MAX_MINKOWSKI_PIECES} face pairs — lower \`detail\` or make the operands convex`);
  }
  const pieces: THREE.BufferGeometry[] = [];
  for (const face of faces) for (const corners of other) pieces.push(smoothHull(pairwiseSums(face, corners)));
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
  const normalsAt = new Map<string, THREE.Vector3[]>();
  for (const [a, b, c] of worldTriangles(geometry, new THREE.Matrix4())) {
    const normal = new THREE.Vector3().crossVectors(b!.clone().sub(a!), c!.clone().sub(a!));
    if (normal.lengthSq() < 1e-18) continue;
    normal.normalize();
    for (const corner of [a!, b!, c!]) {
      const key = keyOf(corner);
      const normals = normalsAt.get(key) ?? [];
      if (!normals.some((known) => known.dot(normal) > 1 - 1e-6)) normals.push(normal);
      normalsAt.set(key, normals);
    }
  }
  const moved = geometry.clone();
  const target = moved.getAttribute("position") as THREE.BufferAttribute;
  const point = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i);
    const offset = offsetDirection(normalsAt.get(keyOf(point)) ?? []);
    point.addScaledVector(offset, -distance);
    target.setXYZ(i, point.x, point.y, point.z);
  }
  target.needsUpdate = true;
  moved.computeBoundingBox();
  moved.computeBoundingSphere();
  return moved;
}

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
