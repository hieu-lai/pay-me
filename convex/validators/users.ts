import { withSystemFields } from 'convex-helpers/server/zod4'
import { z } from 'zod'

export const userValidator = z.object(
  withSystemFields('users', {
    tokenIdentifier: z.string(),
    clerkUserId: z.string(),
    email: z.string().optional(),
    name: z.string().optional(),
    imageUrl: z.string().optional(),
  }),
)
