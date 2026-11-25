const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }

export function parseDuration(value: string): number {
  if (value === "0") return 0
  const parts = [...value.matchAll(/(\d+)(ms|s|m|h)/g)]
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== value) {
    throw new Error(`invalid duration: ${JSON.stringify(value)} (use e.g. 10s, 5m, 1h)`)
  }
  return parts.reduce((sum, [, n, unit]) => sum + Number(n) * UNITS[unit], 0)
}
