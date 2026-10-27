/**
 * Format an INR amount in lakh/crore notation.
 * e.g. 5000000 → "₹50L", 1500000 → "₹15L", 100000 → "₹1L"
 */
export function formatCurrency(amount: number): string {
  if (amount >= 1_00_00_000) {
    return `₹${(amount / 1_00_00_000).toFixed(1)}Cr`;
  }
  if (amount >= 1_00_000) {
    const lakhs = amount / 1_00_000;
    return `₹${lakhs % 1 === 0 ? lakhs.toFixed(0) : lakhs.toFixed(1)}L`;
  }
  if (amount >= 1_000) {
    return `₹${(amount / 1_000).toFixed(0)}K`;
  }
  return `₹${amount.toLocaleString('en-IN')}`;
}

/**
 * Format a percentage, clamped 0–100.
 */
export function formatPercent(value: number, total: number): number {
  if (total === 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

/**
 * Compute a "building health score" 0–100 based on balance and efficiency.
 */
export function buildingHealthScore(floors: { rooms: unknown[] }[]): number {
  if (floors.length === 0) return 0;
  const roomCounts = floors.map(f => f.rooms.length);
  const avg = roomCounts.reduce((a, b) => a + b, 0) / roomCounts.length;
  const variance = roomCounts.reduce((sum, c) => sum + Math.abs(c - avg), 0) / roomCounts.length;
  const balanceScore = Math.max(0, 100 - variance * 20);
  const sizeBonus = Math.min(20, floors.length * 4);
  return Math.min(100, Math.round(balanceScore * 0.8 + sizeBonus));
}

/**
 * Pluralise a word: pluralise(2, "room") → "2 rooms"
 */
export function pluralise(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
