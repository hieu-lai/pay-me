import { NoOp } from 'convex-helpers/server/customFunctions'
import {
  convexToZod,
  zCustomMutation,
  zCustomQuery,
  zid,
  zodOutputToConvex,
} from 'convex-helpers/server/zod4'
import {
  paginationOptsValidator,
  paginationResultValidator,
} from 'convex/server'
import { ConvexError } from 'convex/values'
import { z } from 'zod'

import { internal } from './_generated/api'
import type { Doc, Id } from './_generated/dataModel'
import type { MutationCtx } from './_generated/server'
import { internalMutation, internalQuery } from './_generated/server'
import {
  normalizeLabel,
  protectPaymentDestination,
} from './lib/paymentDestinationCrypto'
import { userAction, userMutation, userQuery } from './lib/userFunctions'
import {
  encryptedPaymentDestinationValidator,
  maskedPaymentDestinationValidator,
  paymentDestinationInputValidator,
  protectedPaymentDestinationValidator,
} from './validators/paymentDestinations'

const zodInternalQuery = zCustomQuery(internalQuery, NoOp)
const zodInternalMutation = zCustomMutation(internalMutation, NoOp)
const MAX_DESTINATIONS_PER_USER = 50
const MAX_SEARCH_TERMS = 16
const MAX_SEARCH_TERM_BYTES = 32
const searchTermPattern = /[\p{L}\p{N}]+/gu
const textEncoder = new TextEncoder()
const destinationTypeToPayIdType = {
  alias_phone: 'mobile',
  alias_email: 'email',
  alias_abn: 'abn',
  alias_organisation_identifier: 'organisationIdentifier',
} as const
const paginationOptsZodValidator = convexToZod(paginationOptsValidator)
const paginatedMaskedPaymentDestinationValidator = convexToZod(
  paginationResultValidator(
    zodOutputToConvex(maskedPaymentDestinationValidator),
  ),
)
const paymentDestinationSearchValidator = z
  .string()
  .superRefine((value, ctx) => {
    const trimmed = value.trim()
    if (!trimmed) return

    const terms = trimmed.match(searchTermPattern) ?? []
    if (terms.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Search must include at least one letter or number.',
      })
      return
    }
    if (terms.length > MAX_SEARCH_TERMS) {
      ctx.addIssue({
        code: 'custom',
        message: `Search can contain at most ${MAX_SEARCH_TERMS} terms.`,
      })
    }
    if (
      terms.some(
        (term) => textEncoder.encode(term).byteLength > MAX_SEARCH_TERM_BYTES,
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `Each search term can contain at most ${MAX_SEARCH_TERM_BYTES} UTF-8 bytes.`,
      })
    }
  })

function notFound(): never {
  throw new ConvexError({
    code: 'PAYMENT_DESTINATION_NOT_FOUND',
    message: 'The payment destination does not exist or is not yours.',
  })
}

async function requireOwnedDestination(
  ctx: Pick<MutationCtx, 'db'>,
  ownerUserId: Id<'users'>,
  destinationId: Id<'paymentDestinations'>,
): Promise<Doc<'paymentDestinations'>> {
  const destination = await ctx.db.get('paymentDestinations', destinationId)
  if (!destination || destination.ownerUserId !== ownerUserId) notFound()
  return destination
}

function maskedResult(
  destination: Doc<'paymentDestinations'>,
  defaultDestinationId: Id<'paymentDestinations'> | undefined,
) {
  const common = {
    id: destination._id,
    ...(destination.label === undefined ? {} : { label: destination.label }),
    maskedDisplay: destination.maskedDisplay,
    isDefault: destination._id === defaultDestinationId,
  }
  return destination.type === 'bban'
    ? {
        kind: 'bankAccount' as const,
        ...common,
      }
    : {
        kind: 'payId' as const,
        payIdType: destinationTypeToPayIdType[destination.type],
        ...common,
      }
}

/** List a page of saved destinations for the owner, with sensitive values masked. */
export const list = userQuery({
  args: {
    paginationOpts: paginationOptsZodValidator,
    search: paymentDestinationSearchValidator.optional(),
  },
  returns: paginatedMaskedPaymentDestinationValidator,
  handler: async (ctx, args) => {
    const search = args.search?.trim()
    const destinations = search
      ? await ctx.db
          .query('paymentDestinations')
          .withSearchIndex('search_by_searchLabel_and_ownerUserId', (q) =>
            q.search('searchLabel', search).eq('ownerUserId', ctx.user._id),
          )
          .paginate(args.paginationOpts)
      : await ctx.db
          .query('paymentDestinations')
          .withIndex('by_ownerUserId', (q) => q.eq('ownerUserId', ctx.user._id))
          .paginate(args.paginationOpts)

    const defaultDestinationId = ctx.user.defaultPaymentDestinationId
    if (search) {
      return {
        ...destinations,
        page: destinations.page.map((destination) =>
          maskedResult(destination, defaultDestinationId),
        ),
      }
    }

    const defaultDestinationInPage = destinations.page.find(
      (destination) => destination._id === defaultDestinationId,
    )
    const page = destinations.page.filter(
      (destination) => destination._id !== defaultDestinationId,
    )

    if (args.paginationOpts.cursor === null && defaultDestinationId) {
      const defaultDestination =
        defaultDestinationInPage ??
        (await ctx.db.get('paymentDestinations', defaultDestinationId))
      if (defaultDestination?.ownerUserId === ctx.user._id) {
        page.unshift(defaultDestination)
      }
    }

    return {
      ...destinations,
      page: page.map((destination) =>
        maskedResult(destination, defaultDestinationId),
      ),
    }
  },
})

/** Encrypt and save a Bank Account for the current user. */
export const create = userAction({
  args: {
    destination: paymentDestinationInputValidator,
    label: z.string().optional(),
    setAsDefault: z.boolean().optional(),
  },
  returns: zid('paymentDestinations'),
  handler: async (ctx, args): Promise<Id<'paymentDestinations'>> => {
    if (args.destination.type !== 'bban') {
      throw new ConvexError({
        code: 'PAYMENT_DESTINATION_METHOD_DISABLED',
        message: 'PayID payment destinations are currently disabled.',
      })
    }

    const protectedDestination = await protectPaymentDestination(
      args.destination,
    )
    return await ctx.runMutation(internal.paymentDestinations.insertProtected, {
      ownerUserId: ctx.user._id,
      protectedDestination,
      ...(args.label === undefined
        ? {}
        : { label: normalizeLabel(args.label) }),
      ...(args.setAsDefault === undefined
        ? {}
        : { setAsDefault: args.setAsDefault }),
    })
  },
})

/** Select an owned destination as the user's default. */
export const setDefault = userMutation({
  args: { destinationId: zid('paymentDestinations') },
  returns: z.null(),
  handler: async (ctx, args) => {
    await requireOwnedDestination(ctx, ctx.user._id, args.destinationId)
    await ctx.db.patch('users', ctx.user._id, {
      defaultPaymentDestinationId: args.destinationId,
    })
    return null
  },
})

/** Change presentation-only metadata without changing destination identity. */
export const updateLabel = userMutation({
  args: {
    destinationId: zid('paymentDestinations'),
    label: z.string().nullable(),
  },
  returns: z.null(),
  handler: async (ctx, args) => {
    await requireOwnedDestination(ctx, ctx.user._id, args.destinationId)
    const label = normalizeLabel(args.label)
    await ctx.db.patch('paymentDestinations', args.destinationId, {
      label,
      searchLabel: label ?? '',
    })
    return null
  },
})

/** Remove an owned destination while preserving the default invariant. */
export const remove = userMutation({
  args: { destinationId: zid('paymentDestinations') },
  returns: z.null(),
  handler: async (ctx, args) => {
    await requireOwnedDestination(ctx, ctx.user._id, args.destinationId)

    if (ctx.user.defaultPaymentDestinationId === args.destinationId) {
      const ownedDestinations = await ctx.db
        .query('paymentDestinations')
        .withIndex('by_ownerUserId', (q) => q.eq('ownerUserId', ctx.user._id))
        .take(2)
      if (ownedDestinations.length > 1) {
        throw new ConvexError({
          code: 'DEFAULT_PAYMENT_DESTINATION_REQUIRED',
          message:
            'Choose another default payment destination before deleting this one.',
        })
      }
      await ctx.db.patch('users', ctx.user._id, {
        defaultPaymentDestinationId: undefined,
      })
    }

    await ctx.db.delete('paymentDestinations', args.destinationId)
    return null
  },
})

export const insertProtected = zodInternalMutation({
  args: {
    ownerUserId: zid('users'),
    protectedDestination: protectedPaymentDestinationValidator,
    label: z.string().optional(),
    setAsDefault: z.boolean().optional(),
  },
  returns: zid('paymentDestinations'),
  handler: async (ctx, args) => {
    const owner = await ctx.db.get('users', args.ownerUserId)
    if (!owner) {
      throw new ConvexError({
        code: 'USER_NOT_FOUND',
        message: 'The payment destination owner no longer exists.',
      })
    }

    const duplicate = await ctx.db
      .query('paymentDestinations')
      .withIndex('by_ownerUserId_and_fingerprint', (q) =>
        q
          .eq('ownerUserId', args.ownerUserId)
          .eq('fingerprint', args.protectedDestination.fingerprint),
      )
      .unique()
    if (duplicate) {
      throw new ConvexError({
        code: 'PAYMENT_DESTINATION_ALREADY_EXISTS',
        message: 'This payment destination is already saved.',
      })
    }

    const existing = await ctx.db
      .query('paymentDestinations')
      .withIndex('by_ownerUserId', (q) => q.eq('ownerUserId', args.ownerUserId))
      .take(MAX_DESTINATIONS_PER_USER)
    if (existing.length >= MAX_DESTINATIONS_PER_USER) {
      throw new ConvexError({
        code: 'PAYMENT_DESTINATION_LIMIT_REACHED',
        message: `A user can save at most ${MAX_DESTINATIONS_PER_USER} payment destinations.`,
      })
    }

    const destinationId = await ctx.db.insert('paymentDestinations', {
      ownerUserId: args.ownerUserId,
      ...args.protectedDestination,
      ...(args.label === undefined ? {} : { label: args.label }),
      searchLabel: args.label ?? '',
    })
    if (
      owner.defaultPaymentDestinationId === undefined ||
      args.setAsDefault === true
    ) {
      await ctx.db.patch('users', owner._id, {
        defaultPaymentDestinationId: destinationId,
      })
    }
    return destinationId
  },
})

export const getEncryptedForOwner = zodInternalQuery({
  args: {
    ownerUserId: zid('users'),
    destinationId: zid('paymentDestinations'),
  },
  returns: encryptedPaymentDestinationValidator,
  handler: async (ctx, args) => {
    const destination = await ctx.db.get(
      'paymentDestinations',
      args.destinationId,
    )
    if (!destination || destination.ownerUserId !== args.ownerUserId) notFound()
    const owner = await ctx.db.get('users', args.ownerUserId)
    if (!owner) notFound()

    const common = {
      id: destination._id,
      ...(destination.label === undefined ? {} : { label: destination.label }),
      isDefault: owner.defaultPaymentDestinationId === destination._id,
    }
    return {
      type: destination.type,
      ciphertext: destination.ciphertext,
      nonce: destination.nonce,
      keyVersion: destination.keyVersion,
      ...common,
    }
  },
})
