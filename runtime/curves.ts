export type CurveInterp = 'linear' | 'log' | 'exp' | 'sCurve' | 'constant';

export interface CurvePoint {
  x: number;
  y: number;
  interp: CurveInterp;
}

function shape(t: number, interp: CurveInterp): number {
  switch (interp) {
    case 'linear': return t;
    // Fast rise then flatten — matches how loudness is perceived over distance.
    case 'log': return Math.log10(1 + 9 * t);
    case 'exp': return (10 ** t - 1) / 9;
    case 'sCurve': return t * t * (3 - 2 * t);
    case 'constant': return 0;
  }
}

/** Evaluate a control-point curve at x. Points are sorted by x; ends clamp. */
export function evaluateCurve(curve: CurvePoint[] | undefined, x: number, fallback = 0): number {
  if (!curve || curve.length === 0) return fallback;
  if (curve.length === 1) return curve[0]!.y;
  const points = curve;
  if (x <= points[0]!.x) return points[0]!.y;
  if (x >= points[points.length - 1]!.x) return points[points.length - 1]!.y;

  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (points[mid]!.x <= x) low = mid;
    else high = mid;
  }
  const a = points[low]!;
  const b = points[high]!;
  const span = b.x - a.x;
  if (span <= 0) return b.y;
  const t = (x - a.x) / span;
  return a.y + (b.y - a.y) * shape(t, a.interp);
}

export function sortCurve(curve: CurvePoint[]): CurvePoint[] {
  return [...curve].sort((a, b) => a.x - b.x);
}

/** True when a curve leaves gaps outside [min, max] of its parameter. */
export function curveCoversRange(curve: CurvePoint[] | undefined, min: number, max: number): boolean {
  if (!curve || curve.length === 0) return false;
  const sorted = sortCurve(curve);
  return sorted[0]!.x <= min && sorted[sorted.length - 1]!.x >= max;
}
