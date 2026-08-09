import { withSystemFields, zid } from 'convex-helpers/server/zod4'
import { z } from 'zod'

export const userValidator = z.object(
  withSystemFields('users', {
    tokenIdentifier: z.string(),
    clerkUserId: z.string(),
    email: z.string(),
    name: z.string(),
    username: z.string().optional(),
    searchText: z.string().optional(),
    imageUrl: z.string().optional(),
    defaultPaymentDestinationId: zid('paymentDestinations').optional(),
  }),
)
