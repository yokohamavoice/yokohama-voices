import assert from "node:assert/strict";
import { convexHull, paddedConvexHull, type MapPoint } from "../lib/opinion-map-geometry.ts";

function contains(polygon: readonly MapPoint[], point: MapPoint) {
  return polygon.every((a, index) => {
    const b = polygon[(index + 1) % polygon.length];
    return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x) >= -1e-8;
  });
}

assert.deepEqual(paddedConvexHull([]), []);
const invalid = [{ x: Infinity, y: 0 }, { x: 0, y: NaN }];
assert.deepEqual(paddedConvexHull(invalid), []);
const duplicate = [{ x: 9, y: 3 }, { x: 9, y: 3 }];
assert.equal(convexHull(duplicate).length, 1);
const circle = paddedConvexHull(duplicate, 8);
assert.equal(circle.length, 24);
assert.ok(contains(circle, duplicate[0]));
assert.ok(circle.every(point => Math.abs(Math.hypot(point.x - 9, point.y - 3) - 8) < 1e-10));

const line = [{ x: -10, y: -2 }, { x: 0, y: 0 }, { x: 10, y: 2 }, { x: 0, y: 0 }];
assert.deepEqual(convexHull(line), [line[0], line[2]]);
const capsule = paddedConvexHull(line);
assert.ok(capsule.length > 3);
assert.ok(line.every(point => contains(capsule, point)));

const square = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
const points = [...square, { x: 1, y: 1 }, square[0], ...invalid];
const original = points.map(point => ({ ...point }));
assert.deepEqual(convexHull(points), square);
const outline = paddedConvexHull(points, 1);
assert.ok(square.every(point => contains(outline, point)));
assert.ok(contains(outline, { x: -1, y: 0 }));
assert.ok(contains(outline, { x: 3, y: 2 }));
assert.deepEqual(points, original);
assert.deepEqual(paddedConvexHull(points, 0), square);
assert.deepEqual(paddedConvexHull(points, -1), square);
assert.deepEqual(paddedConvexHull([...points].reverse()), paddedConvexHull(points));
console.log("PASS: group envelopes contain observed members and handle empty, duplicate, single-point, collinear, invalid, and reordered inputs without mutation.");
