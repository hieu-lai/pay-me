import { withSystemFields, zid } from 'convex-helpers/server/zod4'
import { z } from 'zod'

import { profileImageSourceZodValidator } from './profileImages'

export const userValidator = z.object(
  withSystemFields('users', {
    tokenIdentifier: z.string(),
    clerkUserId: z.string(),
    email: z.string(),
    displayName: z.string(),
    bio: z.string().optional(),
    username: z.string().optional(),
    searchText: z.string(),
    profileImageSource: profileImageSourceZodValidator.optional(),
    defaultPaymentDestinationId: zid('paymentDestinations').optional(),
  }),
)
