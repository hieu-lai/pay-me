import { boundedEvidenceCode } from './lib/evidenceRedaction'

export const creationStates = [
  'queued',
  'submitting',
  'verifying',
  'retry_wait',
  'manual_hold',
  'created',
  'failed',
] as const

export type CreationState = (typeof creationStates)[number]

export type CreationFailureKind =
  | 'provider_outcome_uncertain'
  | 'provider_temporarily_unavailable'
  | 'operator_review_required'
  | 'immutable_request_rejected'

export function creationFailureKind(
  state: CreationState,
  trackingState?: 'checking' | 'retrying',
): CreationFailureKind | undefined {
  switch (state) {
    case 'verifying':
      return trackingState === 'retrying'
        ? 'provider_temporarily_unavailable'
        : 'provider_outcome_uncertain'
    case 'retry_wait':
      return 'provider_temporarily_unavailable'
    case 'manual_hold':
      return 'operator_review_required'
    case 'failed':
      return 'immutable_request_rejected'
    case 'queued':
    case 'submitting':
    case 'created':
      return undefined
  }
}

const transitions: Readonly<Record<CreationState, ReadonlySet<CreationState>>> =
  {
    queued: new Set(['submitting']),
    submitting: new Set([
      'created',
      'verifying',
      'retry_wait',
      'manual_hold',
      'failed',
    ]),
    verifying: new Set(['created', 'retry_wait', 'manual_hold']),
    retry_wait: new Set(['queued']),
    manual_hold: new Set(['queued', 'verifying']),
    created: new Set(),
    failed: new Set(),
  }

export function isLegalCreationTransition(
  from: CreationState,
  to: CreationState,
): boolean {
  return transitions[from].has(to)
}

type ClaimDecisionInput = {
  state: CreationState
  nowMs: number
  postCycle: number
  leaseToken?: string
  leaseExpiresAt?: number
}

export type ClaimDecision =
  | { kind: 'no_op' }
  | { kind: 'claim_post'; postCycle: number; reservedPostAttempts: number }
  | { kind: 'claim_verification'; recoveredExpiredLease: boolean }
  | { kind: 'hold_budget_exhausted' }

export function claimDecision(input: ClaimDecisionInput): ClaimDecision {
  const hasLiveLease =
    input.leaseToken !== undefined &&
    input.leaseExpiresAt !== undefined &&
    input.leaseExpiresAt > input.nowMs
  if (hasLiveLease) return { kind: 'no_op' }

  if (input.state === 'submitting') {
    return { kind: 'claim_verification', recoveredExpiredLease: true }
  }
  if (input.state === 'verifying') {
    return { kind: 'claim_verification', recoveredExpiredLease: false }
  }
  if (input.state !== 'queued') return { kind: 'no_op' }
  if (input.postCycle >= 2) return { kind: 'hold_budget_exhausted' }

  const postCycle = input.postCycle + 1
  return {
    kind: 'claim_post',
    postCycle,
    reservedPostAttempts: postCycle * 3,
  }
}

export function canRecordLeaseOutcome(input: {
  activeToken?: string
  presentedToken: string
  leaseExpiresAt?: number
  nowMs: number
}): boolean {
  return (
    input.activeToken === input.presentedToken &&
    input.leaseExpiresAt !== undefined &&
    input.leaseExpiresAt >= input.nowMs
  )
}

type ProviderError = {
  kind: string
  status?: number
  body?: unknown
}

export type ProviderErrorRecoveryClass = 'verify' | 'retry' | 'hold' | 'fail'

export function creationStateForPostFailure(
  recoveryClass: ProviderErrorRecoveryClass,
  postCycle: number,
): Extract<
  CreationState,
  'verifying' | 'retry_wait' | 'manual_hold' | 'failed'
> {
  if (recoveryClass === 'verify') return 'verifying'
  if (recoveryClass === 'retry') {
    return postCycle < 2 ? 'retry_wait' : 'manual_hold'
  }
  return recoveryClass === 'hold' ? 'manual_hold' : 'failed'
}

function firstProviderCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('errors' in body)) {
    return undefined
  }
  const errors = body.errors
  if (!Array.isArray(errors)) return undefined
  const first = errors[0]
  return typeof first === 'object' &&
    first !== null &&
    'code' in first &&
    typeof first.code === 'string'
    ? first.code
    : undefined
}

export function normalizedProviderErrorCategory(error: ProviderError): string {
  if (error.kind !== 'http') return error.kind
  const status = error.status === undefined ? 'unknown' : String(error.status)
  const code = boundedEvidenceCode(firstProviderCode(error.body))
  return code === undefined ? `http_${status}` : `http_${status}_${code}`
}

const immutableInputCodes = new Set([
  'ZPUNP00',
  'ZPUNP01',
  'ZPUNP02',
  'ZPUNP03',
  'ZPUNP04',
  'ZPUNP05',
  'ZPAGR02',
  'ZPAGR03',
  'ZPAGR04',
  'ZPAGR05',
  'ZPAGR06',
  'ZPAGR07',
  'ZPAGR08',
  'ZPAGR09',
  'ZPAGR10',
  'ZPAGR11',
  'ZPAGR12',
  'ZPAGR13',
  'ZPAGR14',
  'ZPAGR17',
  'ZPAGR18',
])

export function recoveryClassForProviderError(
  error: ProviderError,
): ProviderErrorRecoveryClass {
  if (
    error.kind === 'timeout' ||
    error.kind === 'network' ||
    error.kind === 'invalid_response'
  ) {
    return 'verify'
  }
  if (error.kind === 'configuration' || error.kind === 'sandbox_only') {
    return 'hold'
  }
  if (error.kind !== 'http' || error.status === undefined) return 'hold'
  if (
    error.status === 409 ||
    error.status === 429 ||
    error.status === 500 ||
    error.status === 502 ||
    error.status === 503 ||
    error.status === 504
  ) {
    return 'verify'
  }
  if (error.status === 401 || error.status === 403) return 'hold'
  if (error.status === 400) return 'fail'
  if (error.status === 422) {
    const code = firstProviderCode(error.body)
    if (code === 'ZPAGR00') return 'verify'
    if (code === 'ZPAGR15' || code === 'ZPAGR16') return 'retry'
    if (code === 'ZPAGR01' || code === 'ZPUNP09') return 'hold'
    if (code !== undefined && immutableInputCodes.has(code)) return 'fail'
    return 'hold'
  }
  return 'hold'
}

type NotFoundDecisionInput = {
  postCycle: number
  absenceCount: number
  verificationAttempt: number
  lastPostAt: number
  nowMs: number
}

export type NotFoundDecision =
  | { kind: 'post_again' }
  | { kind: 'verify_later'; delayMs: number }
  | { kind: 'hold' }

const FIRST_CYCLE_DELAYS_MS = [30_000, 2 * 60_000, 5 * 60_000] as const
const SECOND_CYCLE_DELAYS_MS = [
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const
const POST_QUIET_WINDOW_MS = 5 * 60_000

export function decideAfterVerificationFailure(input: {
  postCycle: number
  verificationAttempt: number
  lastPostAt: number
  nowMs: number
}): Exclude<NotFoundDecision, { kind: 'post_again' }> {
  const delays =
    input.postCycle < 2 ? FIRST_CYCLE_DELAYS_MS : SECOND_CYCLE_DELAYS_MS
  const targetOffsetMs = delays.at(input.verificationAttempt - 1)
  return targetOffsetMs === undefined
    ? { kind: 'hold' }
    : {
        kind: 'verify_later',
        delayMs: Math.max(0, input.lastPostAt + targetOffsetMs - input.nowMs),
      }
}

export function decideAfterNotFound({
  postCycle,
  absenceCount,
  verificationAttempt,
  lastPostAt,
  nowMs,
}: NotFoundDecisionInput): NotFoundDecision {
  if (postCycle < 2 && absenceCount >= 2) {
    const quietRemaining = lastPostAt + POST_QUIET_WINDOW_MS - nowMs
    if (quietRemaining <= 0) return { kind: 'post_again' }
  }

  const delays = postCycle < 2 ? FIRST_CYCLE_DELAYS_MS : SECOND_CYCLE_DELAYS_MS
  const targetOffsetMs = delays.at(verificationAttempt - 1)
  return targetOffsetMs === undefined
    ? { kind: 'hold' }
    : {
        kind: 'verify_later',
        delayMs: Math.max(0, lastPostAt + targetOffsetMs - nowMs),
      }
}
