const DAY_MS = 24 * 60 * 60_000

export const PAY_TO_PAYMENT_WORK_RETENTION_MS = 90 * DAY_MS
export const REJECTED_WEBHOOK_RETENTION_MS = 30 * DAY_MS

function shiftUtcYears(timestamp: number, years: number) {
  const shifted = new Date(timestamp)
  shifted.setUTCFullYear(shifted.getUTCFullYear() + years)
  return shifted.getTime()
}

export function paymentAuditExpiresAt(observedAt: number) {
  return shiftUtcYears(observedAt, 7)
}

export function paymentAuditCutoff(nowMs: number) {
  let cutoff = shiftUtcYears(nowMs, -7)
  while (paymentAuditExpiresAt(cutoff) > nowMs) {
    cutoff -= DAY_MS
  }
  return cutoff
}
