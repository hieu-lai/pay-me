import { v } from 'convex/values'
import { z } from 'zod'

export const profileImageMediaTypeValidator = v.union(
  v.literal('image/png'),
  v.literal('image/jpeg'),
  v.literal('image/webp'),
)

export const profileImageRejectionReasonValidator = v.union(
  v.literal('unsupported_media_type'),
  v.literal('too_large'),
  v.literal('dimensions_exceeded'),
  v.literal('animated_not_allowed'),
  v.literal('content_mismatch'),
  v.literal('invalid_content'),
)

export const profileImageSourceValidator = v.union(
  v.object({
    kind: v.literal('legacyExternal'),
    url: v.string(),
  }),
  v.object({
    kind: v.literal('ownedR2'),
    objectKey: v.string(),
  }),
)

export const profileImageSourceZodValidator = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('legacyExternal'), url: z.string() }),
  z.object({ kind: z.literal('ownedR2'), objectKey: z.string() }),
])

export const profileImageUploadStateValidator = v.union(
  v.literal('awaiting_upload'),
  v.literal('validating'),
  v.literal('ready'),
  v.literal('consumed'),
  v.literal('rejected'),
  v.literal('expired'),
)

export const profileImageCleanupObjectKindValidator = v.union(
  v.literal('staging'),
  v.literal('asset'),
)

export const profileImageCleanupStateValidator = v.union(
  v.literal('pending'),
  v.literal('retry'),
)
