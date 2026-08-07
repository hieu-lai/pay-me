import { Migrations } from '@convex-dev/migrations'

import { components, internal } from './_generated/api'
import type { DataModel } from './_generated/dataModel'

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
