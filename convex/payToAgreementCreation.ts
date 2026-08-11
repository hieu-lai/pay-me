import type { Infer } from 'convex/values'
import { ConvexError, v } from 'convex/values'

import { internal } from './_generated/api'
import { internalAction, internalMutation } from './_generated/server'
import { decryptPaymentDestination } from './lib/paymentDestinationCrypto'
import { createBankAccountAgreement } from './lib/zepto/agreement'
import { createSandboxZeptoClientFromEnv } from './lib/zepto/env'
import {
  bankAccountRoutingSnapshotValidator,
  providerAgreementStateValidator,
} from './validators/payToAgreements'

const creationInputValidator = v.object({
  providerUid: v.string(),
  amountCents: v.number(),
  description: v.string(),
  creditorName: v.string(),
  creditorSnapshot: bankAccountRoutingSnapshotValidator,
  debtorName: v.string(),
  debtorSnapshot: bankAccountRoutingSnapshotValidator,
})
type CreationInput = Infer<typeof creationInputValidator>

function unavailable(): never {
  throw new ConvexError({
    code: 'AGREEMENT_CREATION_UNAVAILABLE',
    message: 'PayTo Agreement creation is temporarily unavailable.',
  })
}

export const markCreationStarted = internalMutation({
  args: { payToAgreementId: v.id('payToAgreements'), nowMs: v.number() },
  returns: v.union(creationInputValidator, v.null()),
  handler: async (ctx, args): Promise<CreationInput | null> => {
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    if (!agreement) unavailable()
    if (agreement.creationState === 'created') return null

    const moneyRequest = await ctx.db.get(
      'moneyRequests',
      agreement.moneyRequestId,
    )
    const workItem = await ctx.db
      .query('payToAgreementWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', agreement._id),
      )
      .unique()
    if (!moneyRequest || !workItem || workItem.state === 'completed') {
      unavailable()
    }

    await ctx.db.patch('payToAgreements', agreement._id, {
      creationState: 'submitting',
      creationUpdatedAt: args.nowMs,
    })
    await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
      state: 'running',
      startedAt: args.nowMs,
    })
    return {
      providerUid: agreement.providerUid,
      amountCents: moneyRequest.amountCents,
      description: moneyRequest.description,
      creditorName: moneyRequest.requesterNameSnapshot,
      creditorSnapshot: moneyRequest.creditorSnapshot,
      debtorName: agreement.payerNameSnapshot,
      debtorSnapshot: agreement.debtorSnapshot,
    }
  },
})

export const recordCreated = internalMutation({
  args: {
    payToAgreementId: v.id('payToAgreements'),
    providerState: providerAgreementStateValidator,
    providerCreatedAt: v.number(),
    providerMmsAgreementId: v.union(v.string(), v.null()),
    observedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const agreement = await ctx.db.get('payToAgreements', args.payToAgreementId)
    if (!agreement) unavailable()
    if (agreement.creationState === 'created') return null

    const workItem = await ctx.db
      .query('payToAgreementWorkItems')
      .withIndex('by_payToAgreementId', (q) =>
        q.eq('payToAgreementId', agreement._id),
      )
      .unique()
    if (!workItem) unavailable()

    await ctx.db.patch('payToAgreements', agreement._id, {
      creationState: 'created',
      creationUpdatedAt: args.observedAt,
      lifecycleState: args.providerState,
      lifecycleConfidence: 'provisional',
      lifecycleObservedAt: args.observedAt,
      trackingState: 'verification_due',
      trackingUpdatedAt: args.observedAt,
      providerCreatedAt: args.providerCreatedAt,
      providerMmsAgreementId: args.providerMmsAgreementId,
    })
    await ctx.db.insert('payToAgreementEvidence', {
      payToAgreementId: agreement._id,
      kind: 'provider_create_succeeded',
      providerState: args.providerState,
      providerCreatedAt: args.providerCreatedAt,
      observedAt: args.observedAt,
    })
    await ctx.db.patch('payToAgreementWorkItems', workItem._id, {
      state: 'completed',
      completedAt: args.observedAt,
    })
    return null
  },
})

export const create = internalAction({
  args: { payToAgreementId: v.id('payToAgreements') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const input: CreationInput | null = await ctx.runMutation(
      internal.payToAgreementCreation.markCreationStarted,
      { payToAgreementId: args.payToAgreementId, nowMs: Date.now() },
    )
    if (!input) return null

    const [creditor, debtor] = await Promise.all([
      decryptPaymentDestination({
        type: input.creditorSnapshot.kind,
        ciphertext: input.creditorSnapshot.ciphertext,
        nonce: input.creditorSnapshot.nonce,
        keyVersion: input.creditorSnapshot.keyVersion,
      }),
      decryptPaymentDestination({
        type: input.debtorSnapshot.kind,
        ciphertext: input.debtorSnapshot.ciphertext,
        nonce: input.debtorSnapshot.nonce,
        keyVersion: input.debtorSnapshot.keyVersion,
      }),
    ])
    if (creditor.type !== 'bban' || debtor.type !== 'bban') unavailable()

    const created = await createBankAccountAgreement(
      createSandboxZeptoClientFromEnv(),
      {
        providerUid: input.providerUid,
        amountCents: input.amountCents,
        description: input.description,
        creditor: {
          name: input.creditorName,
          accountIdentifier: creditor.value,
        },
        debtor: {
          name: input.debtorName,
          accountIdentifier: debtor.value,
        },
      },
    )
    await ctx.runMutation(internal.payToAgreementCreation.recordCreated, {
      payToAgreementId: args.payToAgreementId,
      providerState: created.state,
      providerCreatedAt: Date.parse(created.createdAt),
      providerMmsAgreementId: created.mmsAgreementId,
      observedAt: Date.now(),
    })
    return null
  },
})
