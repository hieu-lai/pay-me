import { ConvexError, v } from 'convex/values'

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
  isCanonicalIpv4,
  isCanonicalMoneyRequestIntent,
  verifyIngressAttestation,
} from './lib/moneyRequestIngress'
import { requireUser } from './lib/requireUser'

const intentValidator = v.object({
  submissionKey: v.string(),
  amountCents: v.number(),
  description: v.string(),
  payerId: v.id('users'),
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
  payerId: Id<'users'>
}) {
  if (!isCanonicalMoneyRequestIntent(intent)) {
    safeError(
      'INVALID_INTENT',
      'Use a canonical submission key, integer AUD cents, and a normalized printable-ASCII description.',
    )
  }
}

function generateUuidV7(nowMs: number) {
  const bytes = new Uint8Array(16)
  const random = crypto.getRandomValues(new Uint8Array(10))
  let timestamp = BigInt(nowMs)
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn)
    timestamp >>= 8n
  }
  bytes[6] = 0x70 | (random[0] & 0x0f)
  bytes[7] = random[1]
  bytes[8] = 0x80 | (random[2] & 0x3f)
  bytes.set(random.slice(3), 9)
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
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
  payerId: Id<'users'>,
) {
  if (payerId === requester._id) {
    safeError('INVALID_INTENT', 'A Requester cannot also be the Payer.')
  }
  const payer = await ctx.db.get('users', payerId)
  if (!payer) {
    safeError('PAYER_UNAVAILABLE', 'The selected Payer is unavailable.')
  }
  const requesterDestination = await currentBankAccount(ctx, requester)
  if (!requesterDestination) {
    safeError(
      'REQUESTER_DESTINATION_UNAVAILABLE',
      'Choose an available Bank Account as your Default Destination.',
    )
  }
  const payerDestination = await currentBankAccount(ctx, payer)
  if (!payerDestination) {
    safeError('PAYER_UNAVAILABLE', 'The selected Payer is unavailable.')
  }
  return { payer, requesterDestination, payerDestination }
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

    const preflight:
      | { kind: 'replay'; moneyRequestId: Id<'moneyRequests'> }
      | {
          kind: 'new'
          requesterDestinationId: Id<'paymentDestinations'>
          payerDestinationId: Id<'paymentDestinations'>
        } = await ctx.runQuery(internal.moneyRequests.preflight, {
      intent: args.intent,
      submissionFingerprint: args.attestation.intentDigest,
    })
    if (preflight.kind === 'replay') return preflight.moneyRequestId

    const moneyRequestId: Id<'moneyRequests'> = await ctx.runMutation(
      internal.moneyRequests.accept,
      {
        intent: args.intent,
        submissionFingerprint: args.attestation.intentDigest,
        providerUid: generateUuidV7(nowMs),
        submittedAt: nowMs,
        expectedRequesterDestinationId: preflight.requesterDestinationId,
        expectedPayerDestinationId: preflight.payerDestinationId,
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
      payerDestinationId: v.id('paymentDestinations'),
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
    const { requesterDestination, payerDestination } =
      await resolveDestinations(ctx, requester, args.intent.payerId)
    return {
      kind: 'new' as const,
      requesterDestinationId: requesterDestination.destination._id,
      payerDestinationId: payerDestination.destination._id,
    }
  },
})

export const accept = internalMutation({
  args: {
    intent: intentValidator,
    submissionFingerprint: v.string(),
    providerUid: v.string(),
    submittedAt: v.number(),
    expectedRequesterDestinationId: v.id('paymentDestinations'),
    expectedPayerDestinationId: v.id('paymentDestinations'),
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

    const { payer, requesterDestination, payerDestination } =
      await resolveDestinations(ctx, requester, args.intent.payerId)
    if (
      requesterDestination.destination._id !==
      args.expectedRequesterDestinationId
    ) {
      safeError(
        'REQUESTER_DESTINATION_UNAVAILABLE',
        'Choose an available Bank Account as your Default Destination.',
      )
    }
    if (payerDestination.destination._id !== args.expectedPayerDestinationId) {
      safeError('PAYER_UNAVAILABLE', 'The selected Payer is unavailable.')
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
    const providerUidCollision = await ctx.db
      .query('payToAgreements')
      .withIndex('by_environment_and_providerUid', (q) =>
        q.eq('environment', 'sandbox').eq('providerUid', args.providerUid),
      )
      .unique()
    if (providerUidCollision) {
      safeError(
        'SERVICE_UNAVAILABLE',
        'Money Request submission is temporarily unavailable.',
      )
    }
    const payToAgreementId = await ctx.db.insert('payToAgreements', {
      moneyRequestId,
      payerUserId: payer._id,
      payerNameSnapshot: payer.name,
      sourceDebtorPaymentDestinationId: payerDestination.destination._id,
      debtorSnapshot: payerDestination.snapshot,
      provider: 'zepto',
      environment: 'sandbox',
      apiVersion: '20260101',
      providerUid: args.providerUid,
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
      .take(2)
    if (agreements.length !== 1) {
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
