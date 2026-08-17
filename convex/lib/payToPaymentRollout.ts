import type { Id } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import type {
  PayToPaymentRolloutSafetyCause,
  PayToPaymentCreateErrorCategory,
} from '../validators/payToPayments'

export const ROLLOUT_CLEAN_PERIOD_MS = 7 * 24 * 60 * 60_000
const ROLLOUT_CLEAN_DAY_MS = 24 * 60 * 60_000

export function rolloutCauseForProviderError(
  category: PayToPaymentCreateErrorCategory,
): PayToPaymentRolloutSafetyCause | null {
  if (category === 'duplicate_uid') return 'suspected_duplicate_initiation'
  if (category === 'uid_mismatch') return 'permanent_uid_invariant_breach'
  if (category === 'configuration' || category === 'sandbox_only') {
    return 'certification_mismatch'
  }
  return null
}

export async function failProductionPaymentRolloutClosed(
  ctx: MutationCtx,
  input: {
    environment: 'sandbox' | 'production'
    cause: PayToPaymentRolloutSafetyCause
    observedAt: number
    payToPaymentId?: Id<'payToPayments'>
  },
) {
  if (input.environment !== 'production') return
  await failProductionRolloutClosed(ctx, input)
}

export async function failProductionRolloutForProviderError(
  ctx: MutationCtx,
  input: {
    payment: {
      _id: Id<'payToPayments'>
      environment: 'sandbox' | 'production'
    }
    category: PayToPaymentCreateErrorCategory
    observedAt: number
  },
) {
  const cause = rolloutCauseForProviderError(input.category)
  if (cause === null) return
  await failProductionPaymentRolloutClosed(ctx, {
    environment: input.payment.environment,
    cause,
    observedAt: input.observedAt,
    payToPaymentId: input.payment._id,
  })
}

export async function failProductionRolloutClosed(
  ctx: MutationCtx,
  input: {
    cause: PayToPaymentRolloutSafetyCause
    observedAt: number
    payToPaymentId?: Id<'payToPayments'>
  },
) {
  const gate = await ctx.db
    .query('payToPaymentRuntimeGates')
    .withIndex('by_environment', (q) => q.eq('environment', 'production'))
    .unique()
  const patch = {
    mode: 'reconcile_only' as const,
    rolloutStage: 'reconcile_only_soak' as const,
    stageChangedAt: input.observedAt,
    cleanSince: input.observedAt,
    lastSafetyCause: input.cause,
  }
  if (gate) {
    await ctx.db.patch('payToPaymentRuntimeGates', gate._id, patch)
  } else {
    await ctx.db.insert('payToPaymentRuntimeGates', {
      environment: 'production',
      ...patch,
    })
  }
  await ctx.db.insert('payToPaymentRolloutActions', {
    environment: 'production',
    authentication: 'system',
    authorization: 'automatic_safety_policy',
    action: 'automatic_safety_stop',
    safetyCause: input.cause,
    ...(input.payToPaymentId === undefined
      ? {}
      : { payToPaymentId: input.payToPaymentId }),
    decision: 'authorized',
    resultCode: 'changed',
    requestedAt: input.observedAt,
    ...(gate === null ? {} : { previousMode: gate.mode }),
    nextMode: 'reconcile_only',
  })
}

export async function recordProductionRolloutCleanObservation(
  ctx: MutationCtx,
  observedAt: number,
) {
  const gate = await ctx.db
    .query('payToPaymentRuntimeGates')
    .withIndex('by_environment', (q) => q.eq('environment', 'production'))
    .unique()
  if (
    gate?.cleanSince === undefined ||
    gate.rolloutStage === undefined ||
    gate.lastSafetyCause !== undefined
  ) {
    return false
  }
  const cleanDay = Math.floor(
    (observedAt - gate.cleanSince) / ROLLOUT_CLEAN_DAY_MS,
  )
  if (cleanDay < 1) return false
  const cleanSince = gate.cleanSince
  const existing = await ctx.db
    .query('payToPaymentRolloutCleanObservations')
    .withIndex('by_environment_and_cleanSince_and_cleanDay', (q) =>
      q
        .eq('environment', 'production')
        .eq('cleanSince', cleanSince)
        .eq('cleanDay', cleanDay),
    )
    .unique()
  if (existing) return false
  await ctx.db.insert('payToPaymentRolloutCleanObservations', {
    environment: 'production',
    cleanSince,
    cleanDay,
    observedAt,
  })
  return true
}

export async function hasRequiredCleanRolloutEvidence(
  ctx: Pick<MutationCtx, 'db'>,
  cleanSince: number,
) {
  const observations = await ctx.db
    .query('payToPaymentRolloutCleanObservations')
    .withIndex('by_environment_and_cleanSince_and_cleanDay', (q) =>
      q.eq('environment', 'production').eq('cleanSince', cleanSince),
    )
    .take(7)
  return (
    observations.length === 7 &&
    observations.every(
      (observation, index) => observation.cleanDay === index + 1,
    )
  )
}
