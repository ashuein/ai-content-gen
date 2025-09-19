import { create, all } from 'mathjs';
import type { EqCheck } from '../types';

const math = create(all, { matrix: 'Array' });

export function checkEquation(check: EqCheck): void {
  const node = math.parse(check.expr);
  const value = node.evaluate({ ...check.vars });
  const diff = Math.abs(value - check.expect);
  if (!(Number.isFinite(value) && diff <= check.tol)) {
    throw new Error(`Equation check failed: got ${value}, expect ${check.expect}, tol ${check.tol}`);
  }
}
