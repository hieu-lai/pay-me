import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

const encryptedValue = v.object({
  ciphertext: v.string(),
  nonce: v.string(),
  keyVersion: v.string(),
})

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

  paymentDestinations: defineTable(
    v.union(
      v.object({
        ownerUserId: v.id('users'),
        kind: v.literal('bankAccount'),
        label: v.optional(v.string()),
        searchLabel: v.string(),
        maskedDisplay: v.string(),
        maskedAccountName: v.string(),
        maskedBsb: v.string(),
        maskedAccountNumber: v.string(),
        fingerprint: v.string(),
        accountName: encryptedValue,
        bsb: encryptedValue,
        accountNumber: encryptedValue,
      }),
      v.object({
        ownerUserId: v.id('users'),
        kind: v.literal('payId'),
        payIdType: v.union(
          v.literal('mobile'),
          v.literal('email'),
          v.literal('abn'),
          v.literal('organisationIdentifier'),
        ),
        label: v.optional(v.string()),
        searchLabel: v.string(),
        maskedDisplay: v.string(),
        fingerprint: v.string(),
        ciphertext: v.string(),
        nonce: v.string(),
        keyVersion: v.string(),
      }),
    ),
  )
    .index('by_ownerUserId', ['ownerUserId'])
    .index('by_ownerUserId_and_fingerprint', ['ownerUserId', 'fingerprint'])
    .searchIndex('search_by_searchLabel_and_ownerUserId', {
      searchField: 'searchLabel',
      filterFields: ['ownerUserId'],
    }),
})
