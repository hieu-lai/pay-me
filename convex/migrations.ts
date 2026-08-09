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
