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

export default crons
