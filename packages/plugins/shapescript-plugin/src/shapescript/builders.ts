import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Read an ordered perimeter from a triangulated planar profile. Interior
 * vertices (e.g. the centre of CircleGeometry) must never enter a loft ring. */
export function profileOf(mesh: THREE.Mesh): THREE.Vector3[] {
  mesh.updateWorldMatrix(true, false);
  const positions = mesh.geometry.getAttribute("position");
  const index = mesh.geometry.index;
  const vertices: THREE.Vector3[] = [];
  const ids: number[] = [];
  const unique = new Map<string, number>();
  for (let i = 0; i < positions.count; i++) {
    const point = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld);
    const key = point
      .toArray()
      .map((v) => Math.round(v * 1e6))
      .join(",");
    let id = unique.get(key);
    if (id === undefined) {
      id = vertices.length;
      unique.set(key, id);
      vertices.push(point);
    }
    ids.push(id);
  }
  const edges = new Map<string, { a: number; b: number; count: number }>();
  const count = index?.count ?? positions.count;
  for (let i = 0; i < count; i += 3) {
    const triangle = [0, 1, 2].map((j) => ids[index ? index.getX(i + j) : i + j]!);
    for (let j = 0; j < 3; j++) {
      const a = triangle[j]!,
        b = triangle[(j + 1) % 3]!;
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const edge = edges.get(key);
      if (edge) edge.count++;
      else edges.set(key, { a, b, count: 1 });
    }
  }
  const boundary = [...edges.values()].filter((edge) => edge.count === 1);
  if (boundary.length < 3) throw new Error("Loft/extrude/fill requires planar profiles with a closed perimeter");
  const next = new Map(boundary.map(({ a, b }) => [a, b]));
  const start = boundary[0]!.a;
  let current = start;
  const ring: THREE.Vector3[] = [];
  do {
    ring.push(vertices[current]!);
    const following = next.get(current);
    if (following === undefined || ring.length > boundary.length) throw new Error("Profile perimeter is not a simple closed loop");
    current = following;
  } while (current !== start);
  if (ring.length !== boundary.length) throw new Error("Profiles with holes or multiple perimeters are not supported by this builder");
  return ring;
}

function resample(ring: THREE.Vector3[], count: number): THREE.Vector3[] {
  if (ring.length === count) return ring.map((point) => point.clone());
  const lengths = ring.map((point, i) => point.distanceTo(ring[(i + 1) % ring.length]!));
  const perimeter = lengths.reduce((a, b) => a + b, 0);
  if (perimeter < 1e-10) throw new Error("Loft profile has zero perimeter");
  let edge = 0,
    start = 0;
  return Array.from({ length: count }, (_, i) => {
    const distance = (perimeter * i) / count;
    while (edge < lengths.length - 1 && start + lengths[edge]! < distance) start += lengths[edge++]!;
    return ring[edge]!.clone().lerp(ring[(edge + 1) % ring.length]!, (distance - start) / (lengths[edge] || 1));
  });
}

/** The plane normal of a closed ring, by Newell's method — valid for any planar
 *  polygon, and its SIGN is the ring's winding. */
function ringNormal(ring: THREE.Vector3[]): THREE.Vector3 {
  const normal = new THREE.Vector3();
  for (let i = 0; i < ring.length; i++) {
    const current = ring[i]!,
      next = ring[(i + 1) % ring.length]!;
    normal.x += (current.y - next.y) * (current.z + next.z);
    normal.y += (current.z - next.z) * (current.x + next.x);
    normal.z += (current.x - next.x) * (current.y + next.y);
  }
  return normal;
}

/** Make every ring wind the same way as the one before it.
 *
 *  The side quads connect vertex `i` of one ring to vertex `i` of the next, so
 *  a section whose winding is reversed — which any mirroring transform does,
 *  `scale -1 1 1` among them — stitches inside-out and its faces cancel the
 *  rest, leaving a solid that encloses no volume and is then refused. */
function alignWinding(rings: THREE.Vector3[][]): void {
  for (let r = 1; r < rings.length; r++) {
    if (ringNormal(rings[r]!).dot(ringNormal(rings[r - 1]!)) < 0) rings[r]!.reverse();
  }
}

/** Straight interpolation between successive rings, with triangulated end
 *  caps — or, for a `closed` chain (a section swept around a loop), the last
 *  ring joined back to the first and no caps at all. */
export function loftGeometry(profiles: THREE.Vector3[][], closed = false): THREE.BufferGeometry {
  if (profiles.length < 2) throw new Error("Loft requires at least two cross-sections");
  const count = Math.max(...profiles.map((ring) => ring.length));
  const rings = profiles.map((ring) => resample(ring, count));
  alignWinding(rings);
  const indices: number[] = [];
  const total = rings.length * count;
  for (let r = 0; r < (closed ? rings.length : rings.length - 1); r++) {
    for (let i = 0; i < count; i++) {
      const a = r * count + i,
        b = r * count + ((i + 1) % count);
      indices.push(a, b, (b + count) % total, a, (b + count) % total, (a + count) % total);
    }
  }
  for (const end of closed ? [] : [0, rings.length - 1]) {
    const ring = rings[end]!;
    const origin = ring[0]!;
    const u = ring[1]!.clone().sub(origin).normalize();
    const normal = new THREE.Vector3();
    for (let i = 2; i < count && normal.lengthSq() < 1e-12; i++) normal.crossVectors(u, ring[i]!.clone().sub(origin));
    if (normal.lengthSq() < 1e-12) throw new Error("Loft profile is degenerate");
    normal.normalize();
    const v = normal.clone().cross(u);
    const points = ring.map((point) => {
      const relative = point.clone().sub(origin);
      if (Math.abs(relative.dot(normal)) > 1e-5) throw new Error("Loft cross-sections must be planar");
      return new THREE.Vector2(relative.dot(u), relative.dot(v));
    });
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(points, [])) {
      const offset = end * count;
      if (end === 0) indices.push(offset + c!, offset + b!, offset + a!);
      else indices.push(offset + a!, offset + b!, offset + c!);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      rings.flatMap((ring) => ring.flatMap((p) => p.toArray())),
      3,
    ),
  );
  geometry.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(
      rings.flatMap((_, r) => Array.from({ length: count }, (_, i) => [i / count, r / (rings.length - 1)]).flat()),
      2,
    ),
  );
  geometry.setIndex(indices);
  // Keep winding outward even when the section order goes down the Z axis.
  const position = geometry.getAttribute("position");
  let volume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(position, indices[i]!);
    const b = new THREE.Vector3().fromBufferAttribute(position, indices[i + 1]!);
    const c = new THREE.Vector3().fromBufferAttribute(position, indices[i + 2]!);
    volume += a.dot(b.cross(c));
  }
  if (Math.abs(volume) < 1e-10) {
    geometry.dispose();
    throw new Error("Loft cross-sections enclose no volume");
  }
  if (volume < 0) {
    for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
    geometry.setIndex(indices);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** A section ring (in the XY plane, its normal +Z) placed at every point of a
 *  path, the way `extrude … along` sweeps it: +Z turns to the path tangent
 *  (mitred at corners, and the ring widened there so the walls meet), +Y to
 *  the path's plane normal. A `closed` path wraps the first corner too. */
export function sweepRings(section: THREE.Vector3[], path: THREE.Vector3[], closed: boolean): THREE.Vector3[][] {
  const up = pathUp(path);
  return path.map((origin, i) => {
    const before = closed || i > 0 ? path[(i - 1 + path.length) % path.length]! : undefined;
    const after = closed || i < path.length - 1 ? path[(i + 1) % path.length]! : undefined;
    const incoming = before ? origin.clone().sub(before).normalize() : after!.clone().sub(origin).normalize();
    const outgoing = after ? after.clone().sub(origin).normalize() : incoming;
    const tangent = incoming.clone().add(outgoing);
    if (tangent.lengthSq() < 1e-12) tangent.copy(incoming);
    tangent.normalize();
    // The section is widened across the mitre so the walls on either side of
    // the corner meet: by 1 / cos(θ / 2), capped like a miter limit.
    const widen = Math.min(SWEEP_MITER_LIMIT, 1 / Math.max(1e-6, Math.sqrt(Math.max(0, (1 + incoming.dot(outgoing)) / 2))));
    const binormal = up.clone().cross(tangent);
    if (binormal.lengthSq() < 1e-12) binormal.copy(perpendicularTo(tangent));
    binormal.normalize();
    const normal = tangent.clone().cross(binormal).normalize();
    return section.map((point) => origin.clone().addScaledVector(binormal, point.x * widen).addScaledVector(normal, point.y));
  });
}

const SWEEP_MITER_LIMIT = 4;

/** The plane normal of the path, or for a straight path any direction across it. */
function pathUp(path: THREE.Vector3[]): THREE.Vector3 {
  const normal = ringNormal(path);
  if (normal.lengthSq() > 1e-12) return normal.normalize();
  return perpendicularTo(path[path.length - 1]!.clone().sub(path[0]!).normalize());
}

function perpendicularTo(direction: THREE.Vector3): THREE.Vector3 {
  const axis = Math.abs(direction.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  return axis.cross(direction).normalize();
}

/** An OPEN path extruded: a wall of `depth` along the path with no caps, faced
 *  both ways as upstream draws an open surface. */
export function ribbonGeometry(points: THREE.Vector3[], depth: number): THREE.BufferGeometry {
  if (points.length < 2) throw new Error("Extruding a path needs at least two points");
  const positions = points.flatMap((point) => [point.x, point.y, point.z - depth / 2, point.x, point.y, point.z + depth / 2]);
  const indices: number[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 3, a, a + 3, a + 1);
  }
  const front = new THREE.BufferGeometry();
  front.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  front.setAttribute("uv", new THREE.Float32BufferAttribute(points.flatMap((_, i) => [i / (points.length - 1), 0, i / (points.length - 1), 1]), 2));
  front.setIndex(indices);
  front.computeVertexNormals();
  const back = front.clone();
  back.setIndex(indices.map((_, i) => indices[i - (i % 3) + ((3 - (i % 3)) % 3)]!));
  back.computeVertexNormals();
  const both = mergeGeometries([front, back]);
  front.dispose();
  back.dispose();
  if (!both) throw new Error("Could not build the extruded path");
  return both;
}
