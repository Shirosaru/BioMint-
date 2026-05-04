export function createDefaultState() {
  return {
    version: 1,
    paused: false,
    maxLtvBps: 6000,
    mintCapUsd: 2000000,
    reason: "bootstrap",
    updatedAt: new Date().toISOString()
  };
}

export function toPercent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

export function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}
