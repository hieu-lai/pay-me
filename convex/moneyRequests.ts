import { ConvexError, v } from 'convex/values'
import { v7 as uuid } from 'uuid'

import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import {
  action,
  env,
  internalMutation,
  internalQuery,
  query,
} from './_generated/server'
import {
  MAX_MONEY_REQUEST_PAYER_COUNT,
  fingerprintMoneyRequestTerms,
  isCanonicalIpv4,
  isCanonicalMoneyRequestIntent,
  verifyIngressAttestation,
} from './lib/moneyRequestIngress'
import { requireUser } from './lib/requireUser'

const intentValidator = v.object({
  submissionKey: v.string(),
  amountCents: v.number(),
  description: v.string(),
  payerIds: v.array(v.id('users')),
})
const payerDestinationValidator = v.object({
  payerId: v.id('users'),
  destinationId: v.id('paymentDestinations'),
})
const agreementAllocationValidator = payerDestinationValidator.extend({
  providerUid: v.string(),
})
const attestationValidator = v.object({
  issuedAtMs: v.number(),
  clerkUserId: v.string(),
  trustedIp: v.string(),
  intentDigest: v.string(),
  signature: v.string(),
})
function safeError(
  code:
    | 'INVALID_INTENT'
    | 'SUBMISSION_CONFLICT'
    | 'REQUESTER_DESTINATION_UNAVAILABLE'
    | 'PAYER_UNAVAILABLE'
    | 'INGRESS_TRUST_INVALID'
    | 'UNAUTHENTICATED'
    | 'MONEY_REQUEST_NOT_FOUND'
    | 'SERVICE_UNAVAILABLE',
  message: string,
): never {
  const retryable = code === 'SERVICE_UNAVAILABLE'
  throw new ConvexError({ code, message, retryable })
}

function validateIntent(intent: {
  submissionKey: string
  amountCents: number
  description: string
  payerIds: Id<'users'>[]
}) {
  if (!isCanonicalMoneyRequestIntent(intent)) {
    safeError(
      'INVALID_INTENT',
      'Use a canonical submission key, integer AUD cents, and a normalized printable-ASCII description.',
    )
  }
}

function bankAccountSnapshot(destination: Doc<'paymentDestinations'>) {
  if (destination.type !== 'bban') return null
  return {
    kind: 'bban' as const,
    maskedDisplay: destination.maskedDisplay,
    ciphertext: destination.ciphertext,
    nonce: destination.nonce,
    keyVersion: destination.keyVersion,
  }
}

async function currentBankAccount(
  ctx: Pick<QueryCtx, 'db'>,
  user: Doc<'users'>,
) {
  if (!user.defaultPaymentDestinationId) return null
  const destination = await ctx.db.get(
    'paymentDestinations',
    user.defaultPaymentDestinationId,
  )
  if (!destination || destination.ownerUserId !== user._id) return null
  const snapshot = bankAccountSnapshot(destination)
  if (!snapshot) return null
  return { destination, snapshot }
}

async function existingMoneyRequest(
  ctx: Pick<QueryCtx, 'db'>,
  requesterUserId: Id<'users'>,
  submissionKey: string,
  submissionFingerprint: string,
) {
  const existing = await ctx.db
    .query('moneyRequests')
    .withIndex('by_requesterUserId_and_submissionKey', (q) =>
      q
        .eq('requesterUserId', requesterUserId)
        .eq('submissionKey', submissionKey),
    )
    .unique()
  if (existing && existing.submissionFingerprint !== submissionFingerprint) {
    safeError(
      'SUBMISSION_CONFLICT',
      'This submission key is already bound to another intent.',
    )
  }
  return existing
}

async function resolveDestinations(
  ctx: Pick<QueryCtx, 'db'>,
  requester: Doc<'users'>,
  payerIds: Id<'users'>[],
) {
  if (payerIds.includes(requester._id)) {
    safeError('INVALID_INTENT', 'A Requester cannot also be the Payer.')
  }
  const requesterDestination = await currentBankAccount(ctx, requester)
  if (!requesterDestination) {
    safeError(
      'REQUESTER_DESTINATION_UNAVAILABLE',
      'Choose an available Bank Account as your Default Destination.',
    )
  }
  const payers = []
  for (const payerId of [...payerIds].sort()) {
    const payer = await ctx.db.get('users', payerId)
    if (!payer) {
      safeError('PAYER_UNAVAILABLE', 'A selected Payer is unavailable.')
    }
    const payerDestination = await currentBankAccount(ctx, payer)
    if (!payerDestination) {
      safeError('PAYER_UNAVAILABLE', 'A selected Payer is unavailable.')
    }
    payers.push({ payer, payerDestination })
  }
  return { requesterDestination, payers }
}

export const submit = action({
  args: { intent: intentValidator, attestation: attestationValidator },
  returns: v.id('moneyRequests'),
  handler: async (ctx, args): Promise<Id<'moneyRequests'>> => {
    validateIntent(args.intent)
    const identity = await ctx.auth.getUserIdentity()
    if (!identity) {
      safeError(
        'UNAUTHENTICATED',
        'You must be signed in to submit a Money Request.',
      )
    }

    const nowMs = Date.now()
    const trusted =
      isCanonicalIpv4(args.attestation.trustedIp) &&
      (await verifyIngressAttestation(args.intent, args.attestation, {
        nowMs,
        clerkUserId: identity.subject,
        secret: env.MONEY_REQUEST_INGRESS_ATTESTATION_SECRET,
      }))
    if (!trusted) {
      safeError(
        'INGRESS_TRUST_INVALID',
        'Submission must come through the trusted server ingress.',
      )
    }

    const submissionFingerprint = await fingerprintMoneyRequestTerms(
      args.intent,
    )

    const preflight:
      | { kind: 'replay'; moneyRequestId: Id<'moneyRequests'> }
      | {
          kind: 'new'
          requesterDestinationId: Id<'paymentDestinations'>
          payerDestinations: Array<{
            payerId: Id<'users'>
            destinationId: Id<'paymentDestinations'>
          }>
        } = await ctx.runQuery(internal.moneyRequests.preflight, {
      intent: args.intent,
      submissionFingerprint,
    })
    if (preflight.kind === 'replay') return preflight.moneyRequestId

    const moneyRequestId: Id<'moneyRequests'> = await ctx.runMutation(
      internal.moneyRequests.accept,
      {
        intent: args.intent,
        submissionFingerprint,
        agreementAllocations: preflight.payerDestinations.map(
          ({ payerId, destinationId }) => ({
            payerId,
            destinationId,
            providerUid: uuid({ msecs: nowMs }),
          }),
        ),
        submittedAt: nowMs,
        expectedRequesterDestinationId: preflight.requesterDestinationId,
      },
    )
    return moneyRequestId
  },
})

export const preflight = internalQuery({
  args: {
    intent: intentValidator,
    submissionFingerprint: v.string(),
  },
  returns: v.union(
    v.object({
      kind: v.literal('replay'),
      moneyRequestId: v.id('moneyRequests'),
    }),
    v.object({
      kind: v.literal('new'),
      requesterDestinationId: v.id('paymentDestinations'),
      payerDestinations: v.array(payerDestinationValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const requester = await requireUser(ctx)
    const existing = await existingMoneyRequest(
      ctx,
      requester._id,
      args.intent.submissionKey,
      args.submissionFingerprint,
    )
    if (existing) {
      return { kind: 'replay' as const, moneyRequestId: existing._id }
    }
    const { requesterDestination, payers } = await resolveDestinations(
      ctx,
      requester,
      args.intent.payerIds,
    )
    return {
      kind: 'new' as const,
      requesterDestinationId: requesterDestination.destination._id,
      payerDestinations: payers.map(({ payer, payerDestination }) => ({
        payerId: payer._id,
        destinationId: payerDestination.destination._id,
      })),
    }
  },
})

export const accept = internalMutation({
  args: {
    intent: intentValidator,
    submissionFingerprint: v.string(),
    agreementAllocations: v.array(agreementAllocationValidator),
    submittedAt: v.number(),
    expectedRequesterDestinationId: v.id('paymentDestinations'),
  },
  returns: v.id('moneyRequests'),
  handler: async (ctx, args) => {
    const requester = await requireUser(ctx)
    const existing = await existingMoneyRequest(
      ctx,
      requester._id,
      args.intent.submissionKey,
      args.submissionFingerprint,
    )
    if (existing) {
      return existing._id
    }

    const { requesterDestination, payers } = await resolveDestinations(
      ctx,
      requester,
      args.intent.payerIds,
    )
    if (
      requesterDestination.destination._id !==
      args.expectedRequesterDestinationId
    ) {
      safeError(
        'REQUESTER_DESTINATION_UNAVAILABLE',
        'Choose an available Bank Account as your Default Destination.',
      )
    }
    const allocationsByPayerId = new Map(
      args.agreementAllocations.map((allocation) => [
        allocation.payerId,
        allocation,
      ]),
    )
    if (
      allocationsByPayerId.size !== payers.length ||
      args.agreementAllocations.length !== payers.length
    ) {
      safeError(
        'SERVICE_UNAVAILABLE',
        'Money Request submission is temporarily unavailable.',
      )
    }
    for (const { payer, payerDestination } of payers) {
      const allocation = allocationsByPayerId.get(payer._id)
      if (
        !allocation ||
        allocation.destinationId !== payerDestination.destination._id
      ) {
        safeError('PAYER_UNAVAILABLE', 'A selected Payer is unavailable.')
      }
    }
    if (
      new Set(args.agreementAllocations.map(({ providerUid }) => providerUid))
        .size !== args.agreementAllocations.length
    ) {
      safeError(
        'SERVICE_UNAVAILABLE',
        'Money Request submission is temporarily unavailable.',
      )
    }
    for (const { providerUid } of args.agreementAllocations) {
      const providerUidCollision = await ctx.db
        .query('payToAgreements')
        .withIndex('by_environment_and_providerUid', (q) =>
          q.eq('environment', 'sandbox').eq('providerUid', providerUid),
        )
        .unique()
      if (providerUidCollision) {
        safeError(
          'SERVICE_UNAVAILABLE',
          'Money Request submission is temporarily unavailable.',
        )
      }
    }
    const moneyRequestId = await ctx.db.insert('moneyRequests', {
      requesterUserId: requester._id,
      requesterNameSnapshot: requester.name,
      amountCents: args.intent.amountCents,
      currency: 'AUD',
      purpose: 'other',
      description: args.intent.description,
      submissionKey: args.intent.submissionKey,
      submissionFingerprint: args.submissionFingerprint,
      sourceCreditorPaymentDestinationId: requesterDestination.destination._id,
      creditorSnapshot: requesterDestination.snapshot,
      submittedAt: args.submittedAt,
    })
    for (const { payer, payerDestination } of payers) {
      const allocation = allocationsByPayerId.get(payer._id)!
      const payToAgreementId = await ctx.db.insert('payToAgreements', {
        moneyRequestId,
        payerUserId: payer._id,
        payerNameSnapshot: payer.name,
        sourceDebtorPaymentDestinationId: payerDestination.destination._id,
        debtorSnapshot: payerDestination.snapshot,
        provider: 'zepto',
        environment: 'sandbox',
        apiVersion: '20260101',
        providerUid: allocation.providerUid,
        creationState: 'queued',
        creationUpdatedAt: args.submittedAt,
        lifecycleState: 'pending',
        lifecycleConfidence: 'provisional',
        lifecycleObservedAt: args.submittedAt,
        trackingState: 'verification_due',
        trackingUpdatedAt: args.submittedAt,
      })
      await ctx.db.insert('payToAgreementEvidence', {
        payToAgreementId,
        kind: 'local_accepted',
        observedAt: args.submittedAt,
      })
      await ctx.db.insert('payToAgreementWorkItems', {
        payToAgreementId,
        kind: 'create',
        state: 'queued',
        availableAt: args.submittedAt,
      })
    }
    return moneyRequestId
  },
})

export const get = query({
  args: { moneyRequestId: v.id('moneyRequests') },
  returns: v.object({
    id: v.id('moneyRequests'),
    amountCents: v.number(),
    currency: v.literal('AUD'),
    purpose: v.literal('other'),
    description: v.string(),
    submittedAt: v.number(),
    agreements: v.array(
      v.object({
        payer: v.object({ name: v.string() }),
        creation: v.object({
          state: v.literal('queued'),
          updatedAt: v.number(),
        }),
        lifecycle: v.object({
          meaning: v.literal('waitingForPayer'),
          confidence: v.literal('provisional'),
          observedAt: v.number(),
        }),
        tracking: v.object({
          state: v.literal('verificationDue'),
          updatedAt: v.number(),
        }),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const requester = await requireUser(ctx)
    const moneyRequest = await ctx.db.get('moneyRequests', args.moneyRequestId)
    if (!moneyRequest || moneyRequest.requesterUserId !== requester._id) {
      safeError('MONEY_REQUEST_NOT_FOUND', 'The Money Request was not found.')
    }
    const agreements = await ctx.db
      .query('payToAgreements')
      .withIndex('by_moneyRequestId', (q) =>
        q.eq('moneyRequestId', moneyRequest._id),
      )
      .take(MAX_MONEY_REQUEST_PAYER_COUNT + 1)
    if (
      agreements.length < 1 ||
      agreements.length > MAX_MONEY_REQUEST_PAYER_COUNT
    ) {
      safeError(
        'SERVICE_UNAVAILABLE',
        'Money Request details are temporarily unavailable.',
      )
    }
    return {
      id: moneyRequest._id,
      amountCents: moneyRequest.amountCents,
      currency: moneyRequest.currency,
      purpose: moneyRequest.purpose,
      description: moneyRequest.description,
      submittedAt: moneyRequest.submittedAt,
      agreements: agreements.map((agreement) => ({
        payer: { name: agreement.payerNameSnapshot },
        creation: {
          state: agreement.creationState,
          updatedAt: agreement.creationUpdatedAt,
        },
        lifecycle: {
          meaning: 'waitingForPayer' as const,
          confidence: agreement.lifecycleConfidence,
          observedAt: agreement.lifecycleObservedAt,
        },
        tracking: {
          state: 'verificationDue' as const,
          updatedAt: agreement.trackingUpdatedAt,
        },
      })),
    }
  },
})
