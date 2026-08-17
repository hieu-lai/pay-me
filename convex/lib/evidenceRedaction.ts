export async function fingerprintSensitiveIdentifier(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

const SAFE_EVIDENCE_CODE = /^[A-Za-z0-9._~-]{1,128}$/

export function boundedEvidenceCode(value: unknown) {
  return typeof value === 'string' && SAFE_EVIDENCE_CODE.test(value)
    ? value
    : undefined
}

export function safeWebhookReason(
  reason: { code?: string; title?: string; detail?: string } | undefined,
) {
  const code = boundedEvidenceCode(reason?.code)
  return code === undefined ? undefined : { code }
}
