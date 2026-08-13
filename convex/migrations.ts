import { Migrations } from '@convex-dev/migrations'

import { components, internal } from './_generated/api'
import type { DataModel } from './_generated/dataModel'
import { userSearchText } from './lib/userSearch'

export const migrations = new Migrations<DataModel>(components.migrations)

export function searchLabelFor(label: string | undefined): string {
  return label ?? ''
}

export function paymentDestinationSearchLabelPatch(destination: {
  label?: string
  searchLabel?: string
}): { searchLabel: string } | undefined {
  if (destination.searchLabel !== undefined) return
  return { searchLabel: searchLabelFor(destination.label) }
}

export const backfillPaymentDestinationSearchLabel = migrations.define({
  table: 'paymentDestinations',
  migrateOne: async (_ctx, destination) =>
    paymentDestinationSearchLabelPatch(destination),
})

export const runBackfillPaymentDestinationSearchLabel = migrations.runner(
  internal.migrations.backfillPaymentDestinationSearchLabel,
)

export const backfillUserSearchText = migrations.define({
  table: 'users',
  migrateOne: async (_ctx, user) => {
    if (user.searchText !== undefined) return
    return {
      searchText: userSearchText({
        name: user.name,
        ...(user.username === undefined ? {} : { username: user.username }),
      }),
    }
  },
})

export const runBackfillUserSearchText = migrations.runner(
  internal.migrations.backfillUserSearchText,
)

export const excludeLegacyPayToAgreements = migrations.define({
  table: 'payToAgreements',
  migrateOne: async (_ctx, agreement) => {
    if (agreement.activationProvenancePolicy !== undefined) return
    return {
      activationProvenancePolicy:
        agreement.firstConfirmedActiveAt === undefined
          ? ('legacy_excluded' as const)
          : ('track_first_confirmation' as const),
    }
  },
})

export const runExcludeLegacyPayToAgreements = migrations.runner(
  internal.migrations.excludeLegacyPayToAgreements,
)

export const deleteAllPayToAgreementEvidence = migrations.define({
  table: 'payToAgreementEvidence',
  migrateOne: async (ctx, evidence) => {
    await ctx.db.delete('payToAgreementEvidence', evidence._id)
  },
})

export const deleteAllPayToAgreementWorkItems = migrations.define({
  table: 'payToAgreementWorkItems',
  migrateOne: async (ctx, workItem) => {
    await ctx.db.delete('payToAgreementWorkItems', workItem._id)
  },
})

export const deleteAllPayToAgreements = migrations.define({
  table: 'payToAgreements',
  migrateOne: async (ctx, agreement) => {
    await ctx.db.delete('payToAgreements', agreement._id)
  },
})

export const deleteAllMoneyRequests = migrations.define({
  table: 'moneyRequests',
  migrateOne: async (ctx, moneyRequest) => {
    await ctx.db.delete('moneyRequests', moneyRequest._id)
  },
})

export const runDeleteAllMoneyRequestData = migrations.runner([
  internal.migrations.deleteAllPayToAgreementEvidence,
  internal.migrations.deleteAllPayToAgreementWorkItems,
  internal.migrations.deleteAllPayToAgreements,
  internal.migrations.deleteAllMoneyRequests,
])
