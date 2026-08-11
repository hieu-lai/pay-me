import type { Id } from '../_generated/dataModel'

const textEncoder = new TextEncoder()

export type MoneyRequestIntent = {
  submissionKey: string
  amountCents: number
  description: string
  payerIds: Id<'users'>[]
}

export type MoneyRequestTerms = Omit<MoneyRequestIntent, 'submissionKey'>

export type IngressAttestation = {
  issuedAtMs: number
  clerkUserId: string
  trustedIp: string
  intentDigest: string
  signature: string
}

export const MAX_ATTESTATION_AGE_MS = 60_000
export const MIN_MONEY_REQUEST_AMOUNT_CENTS = 1
export const MAX_MONEY_REQUEST_AMOUNT_CENTS = 1_000_000_000
export const MIN_MONEY_REQUEST_PAYER_COUNT = 1
export const MAX_MONEY_REQUEST_PAYER_COUNT = 5
export const CANONICAL_UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const MONEY_REQUEST_DESCRIPTION_PATTERN = /^[\x20-\x7e]{1,140}$/
const MIN_ATTESTATION_SECRET_BYTES = 32

function hasStrongAttestationSecret(secret: string) {
  return textEncoder.encode(secret).byteLength >= MIN_ATTESTATION_SECRET_BYTES
}

function bytesToBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    const padding = '='.repeat((4 - (value.length % 4)) % 4)
    const binary = atob(
      value.replaceAll('-', '+').replaceAll('_', '/') + padding,
    )
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

function requestTermsTuple(intent: MoneyRequestTerms) {
  return [
    intent.amountCents,
    intent.description,
    [...intent.payerIds].sort(),
  ] as const
}

export function canonicalIntent(intent: MoneyRequestIntent) {
  return JSON.stringify([intent.submissionKey, ...requestTermsTuple(intent)])
}

export function isCanonicalMoneyRequestPayerSet(
  payerIds: readonly Id<'users'>[],
) {
  return (
    payerIds.length >= MIN_MONEY_REQUEST_PAYER_COUNT &&
    payerIds.length <= MAX_MONEY_REQUEST_PAYER_COUNT &&
    new Set(payerIds).size === payerIds.length
  )
}

function canonicalRequestTerms(intent: MoneyRequestTerms) {
  return JSON.stringify([1, ...requestTermsTuple(intent)])
}

export function isCanonicalMoneyRequestIntent(intent: MoneyRequestIntent) {
  return (
    CANONICAL_UUID_V7_PATTERN.test(intent.submissionKey) &&
    Number.isSafeInteger(intent.amountCents) &&
    intent.amountCents >= MIN_MONEY_REQUEST_AMOUNT_CENTS &&
    intent.amountCents <= MAX_MONEY_REQUEST_AMOUNT_CENTS &&
    MONEY_REQUEST_DESCRIPTION_PATTERN.test(intent.description) &&
    intent.description === intent.description.normalize('NFC').trim() &&
    isCanonicalMoneyRequestPayerSet(intent.payerIds)
  )
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(value),
  )
  return bytesToBase64Url(new Uint8Array(digest))
}

export async function digestMoneyRequestIntent(intent: MoneyRequestIntent) {
  return await sha256(canonicalIntent(intent))
}

export async function fingerprintMoneyRequestTerms(intent: MoneyRequestTerms) {
  return await sha256(canonicalRequestTerms(intent))
}

function attestationPayload(
  attestation: Omit<IngressAttestation, 'signature'>,
) {
  return JSON.stringify([
    1,
    attestation.issuedAtMs,
    attestation.clerkUserId,
    attestation.trustedIp,
    attestation.intentDigest,
  ])
}

async function importAttestationKey(secret: string) {
  return await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

export async function createIngressAttestation(
  intent: MoneyRequestIntent,
  context: {
    issuedAtMs: number
    clerkUserId: string
    trustedIp: string
    secret: string
  },
): Promise<IngressAttestation> {
  if (!hasStrongAttestationSecret(context.secret)) {
    throw new Error('Money Request ingress attestation is not configured.')
  }
  const unsigned = {
    issuedAtMs: context.issuedAtMs,
    clerkUserId: context.clerkUserId,
    trustedIp: context.trustedIp,
    intentDigest: await digestMoneyRequestIntent(intent),
  }
  const signature = await crypto.subtle.sign(
    'HMAC',
    await importAttestationKey(context.secret),
    textEncoder.encode(attestationPayload(unsigned)),
  )
  return {
    ...unsigned,
    signature: bytesToBase64Url(new Uint8Array(signature)),
  }
}

export async function verifyIngressAttestation(
  intent: MoneyRequestIntent,
  attestation: IngressAttestation,
  context: { nowMs: number; clerkUserId: string; secret: string },
) {
  if (!hasStrongAttestationSecret(context.secret)) return false
  if (
    attestation.clerkUserId !== context.clerkUserId ||
    !Number.isSafeInteger(attestation.issuedAtMs) ||
    attestation.issuedAtMs > context.nowMs ||
    context.nowMs - attestation.issuedAtMs > MAX_ATTESTATION_AGE_MS ||
    attestation.intentDigest !== (await digestMoneyRequestIntent(intent))
  ) {
    return false
  }

  const signature = base64UrlToBytes(attestation.signature)
  if (!signature) return false

  return await crypto.subtle.verify(
    'HMAC',
    await importAttestationKey(context.secret),
    signature,
    textEncoder.encode(
      attestationPayload({
        issuedAtMs: attestation.issuedAtMs,
        clerkUserId: attestation.clerkUserId,
        trustedIp: attestation.trustedIp,
        intentDigest: attestation.intentDigest,
      }),
    ),
  )
}

export function isCanonicalIpv4(value: string) {
  const octets = value.split('.')
  return (
    octets.length === 4 &&
    octets.every(
      (octet) => /^(?:0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255,
    )
  )
}
