/**
 * 線形補間方式のパーセンタイル (PTA / PD 共通)。
 * @param {ArrayLike<number>} sorted 昇順ソート済みであること
 * @param {number} p 0〜100
 * @returns {number} 空配列なら NaN
 */
export function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const idx = ((n - 1) * p) / 100;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
