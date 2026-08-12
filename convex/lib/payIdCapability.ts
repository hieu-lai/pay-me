import { payIdAliasTypes } from '../validators/paymentDestinations'

function positiveInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function payIdCapabilityStatus(
  encoded: string | undefined,
  releaseCommit: string | undefined,
): {
  kind: 'disabled' | 'enabled' | 'misconfigured'
} {
  if (encoded === undefined || encoded === '') return { kind: 'disabled' }
  let value: unknown
  try {
    value = JSON.parse(encoded)
  } catch {
    return { kind: 'misconfigured' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'misconfigured' }
  }
  const config = value as Record<string, unknown>
  if (config.enabled === false) return { kind: 'disabled' }
  const kinds = config.aliasKinds
  const limits = config.fraudLimits
  const complete =
    config.enabled === true &&
    config.trustedIpv4 === true &&
    config.payToAliasesScope === true &&
    config.liveAliasResolution === true &&
    config.privacyAssertions === true &&
    Array.isArray(kinds) &&
    kinds.length === payIdAliasTypes.length &&
    payIdAliasTypes.every((kind) => kinds.includes(kind)) &&
    typeof limits === 'object' &&
    limits !== null &&
    !Array.isArray(limits) &&
    positiveInteger((limits as Record<string, unknown>).account) &&
    positiveInteger((limits as Record<string, unknown>).remoteIp) &&
    positiveInteger((limits as Record<string, unknown>).requester) &&
    typeof config.certificationCommit === 'string' &&
    /^[0-9a-f]{40}$/.test(config.certificationCommit) &&
    config.certificationCommit === releaseCommit
  return { kind: complete ? 'enabled' : 'misconfigured' }
}

export async function pseudonymousPayIdRequesterId(
  identity: string,
  secret: string,
) {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error('PayID requester pseudonym secret is unavailable.')
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(identity)),
  )
  const encoded = btoa(String.fromCharCode(...signature))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
  return `payme_${encoded}`
}
