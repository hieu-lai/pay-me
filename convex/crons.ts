import { cronJobs } from 'convex/server'

import { internal } from './_generated/api'

const crons = cronJobs()

crons.interval(
  'dispatch due PayTo lifecycle reconciliation',
  { minutes: 1 },
  internal.payToAgreementReconciliation.dispatchDue,
  {},
)

crons.interval(
  'dispatch due PayTo Payment reconciliation',
  { minutes: 1 },
  internal.payToPaymentReconciliation.dispatchDue,
  {},
)

crons.interval(
  'dispatch due PayTo Payment creation recovery',
  { seconds: 30 },
  internal.payToPayments.dispatchCreationRecoveryDue,
  {},
)

crons.interval(
  'dispatch due PayTo Payment retries',
  { minutes: 1 },
  internal.payToPaymentRetry.dispatchDue,
  {},
)

crons.interval(
  'emit PayTo Payment aggregate monitoring',
  { minutes: 5 },
  internal.payToPaymentMonitoring.emitAggregateSnapshot,
  {},
)

crons.interval(
  'scan PayTo Payment rollout safety',
  { hours: 1 },
  internal.payToPaymentRolloutMonitoring.start,
  {},
)

crons.interval(
  'sweep aged unresolved PayTo Payments',
  { hours: 1 },
  internal.payToPaymentMonitoring.sweepAgedUnresolved,
  {
    paginationOpts: {
      numItems: 100,
      cursor: null,
      maximumRowsRead: 100,
      maximumBytesRead: 1_000_000,
    },
  },
)

crons.interval(
  'delete expired PayTo Payment records',
  { hours: 24 },
  internal.payToPaymentRetention.cleanupExpired,
  {},
)

export default crons
