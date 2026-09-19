export type MapPoint = Readonly<{ x: number; y: number }>;

/** The observed extent, including sparse, duplicate, and collinear groups. */
export function convexHull(points: readonly MapPoint[]): MapPoint[] {
  const sorted = points.filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    .slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const unique = sorted.filter((point, index) => !index || point.x !== sorted[index - 1].x || point.y !== sorted[index - 1].y);
  if (unique.length < 3) return unique;
  const cross = (a: MapPoint, b: MapPoint, c: MapPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const lower: MapPoint[] = [], upper: MapPoint[] = [];
  for (const point of unique) {
    while (lower.length > 1 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  for (let index = unique.length - 1; index >= 0; index--) {
    const point = unique[index];
    while (upper.length > 1 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/** Add a small rounded display margin in canvas units, not a statistical interval. */
export function paddedConvexHull(points: readonly MapPoint[], padding = 8): MapPoint[] {
  const hull = convexHull(points);
  if (!(padding > 0) || !Number.isFinite(padding)) return hull;
  const expanded: MapPoint[] = [];
  for (const point of hull) for (let step = 0; step < 24; step++) {
    const angle = step * Math.PI / 12;
    expanded.push({ x: point.x + padding * Math.cos(angle), y: point.y + padding * Math.sin(angle) });
  }
  return convexHull(expanded);
}
