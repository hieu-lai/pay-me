import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    clerkUserId: v.string(),
    email: v.string(),
    name: v.string(),
    username: v.optional(v.string()),
    searchText: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    defaultPaymentDestinationId: v.optional(v.id('paymentDestinations')),
  })
    .index('by_tokenIdentifier', ['tokenIdentifier'])
    .index('by_clerkUserId', ['clerkUserId'])
    .searchIndex('search_by_searchText', {
      searchField: 'searchText',
    }),

  paymentDestinations: defineTable({
    ownerUserId: v.id('users'),
    type: v.union(
      v.literal('bban'),
      v.literal('alias_phone'),
      v.literal('alias_email'),
      v.literal('alias_abn'),
      v.literal('alias_organisation_identifier'),
    ),
    label: v.optional(v.string()),
    searchLabel: v.string(),
    maskedDisplay: v.string(),
    fingerprint: v.string(),
    ciphertext: v.string(),
    nonce: v.string(),
    keyVersion: v.string(),
  })
    .index('by_ownerUserId', ['ownerUserId'])
    .index('by_ownerUserId_and_fingerprint', ['ownerUserId', 'fingerprint'])
    .searchIndex('search_by_searchLabel_and_ownerUserId', {
      searchField: 'searchLabel',
      filterFields: ['ownerUserId'],
    }),
})
