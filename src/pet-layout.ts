export function petScale(scale: number) { return Number.isFinite(scale) ? Math.max(.5, Math.min(2, scale)) : 1; }
export function petWidth(scale: number) { return Math.round(324 * petScale(scale)); }
export function petSize(scale: number, contentHeight: number, work: { width: number; height: number }) {
  const safeScale = petScale(scale);
  return { width: petWidth(safeScale),
    height: Math.min(Math.ceil(168 * safeScale + 84 + Math.max(0, Math.min(220, contentHeight))), work.height) };
}
