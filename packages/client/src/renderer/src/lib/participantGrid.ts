import type { CSSProperties } from 'react';

/**
 * Grid rules: 1 tile fills all available space. 2 tiles stack full-width in
 * 2 rows. From 3 up, fixed 2 columns, rows = ceil(n/2); when n is odd, the
 * last tile spans both columns but is width-capped so it renders centered
 * at the same size as its siblings, sitting at the seam of the row above.
 */
export function getGridContainerStyle(count: number): CSSProperties {
  if (count <= 1) {
    return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' };
  }
  if (count === 2) {
    return { gridTemplateColumns: '1fr', gridTemplateRows: 'repeat(2, 1fr)' };
  }
  const rows = Math.ceil(count / 2);
  return { gridTemplateColumns: 'repeat(2, 1fr)', gridTemplateRows: `repeat(${rows}, 1fr)` };
}

export function getGridItemStyle(index: number, count: number): CSSProperties {
  const isLastOddOut = count >= 3 && count % 2 === 1 && index === count - 1;
  if (isLastOddOut) {
    return { gridColumn: '1 / span 2', width: '50%', justifySelf: 'center' };
  }
  return {};
}
