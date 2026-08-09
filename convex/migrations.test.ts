/// <reference types="vite/client" />

import { runToCompletion } from '@convex-dev/migrations'
import migrationComponent from '@convex-dev/migrations/test'
import { convexTest } from 'convex-test'
import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { expect, test } from 'vitest'

import { components, internal } from './_generated/api'

const modules = import.meta.glob('./**/*.ts')
const encryptedValue = v.object({
  ciphertext: v.string(),
  nonce: v.string(),
  keyVersion: v.string(),
})
const legacySchema = defineSchema({
  paymentDestinations: defineTable(
    v.union(
      v.object({
        ownerUserId: v.id('users'),
        kind: v.literal('bankAccount'),
        label: v.optional(v.string()),
        searchLabel: v.optional(v.string()),
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
        searchLabel: v.optional(v.string()),
        maskedDisplay: v.string(),
        fingerprint: v.string(),
        ciphertext: v.string(),
        nonce: v.string(),
        keyVersion: v.string(),
      }),
    ),
  ),
  users: defineTable({
    tokenIdentifier: v.string(),
    clerkUserId: v.string(),
    email: v.string(),
    name: v.string(),
    username: v.optional(v.string()),
    searchText: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    defaultPaymentDestinationId: v.optional(v.id('paymentDestinations')),
  }),
})

test('backfills missing payment destination search labels idempotently', async () => {
  const t = convexTest(legacySchema, modules)
  migrationComponent.register(t)

  const { labeledId, unlabeledId } = await t.run(async (ctx) => {
    const ownerUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'issuer|migration-user',
      clerkUserId: 'migration-user',
      email: 'migration@example.com',
      name: 'Migration User',
    })
    const encrypted = {
      ciphertext: 'ciphertext',
      nonce: 'nonce',
      keyVersion: 'v1',
    }
    const insertedLabeledId = await ctx.db.insert('paymentDestinations', {
      ownerUserId,
      kind: 'bankAccount',
      label: 'Everyday',
      maskedDisplay: 'Bank account ••••1234',
      maskedAccountName: 'M******** U***',
      maskedBsb: '***-456',
      maskedAccountNumber: '••••1234',
      fingerprint: 'labeled-fingerprint',
      accountName: encrypted,
      bsb: encrypted,
      accountNumber: encrypted,
    })
    const insertedUnlabeledId = await ctx.db.insert('paymentDestinations', {
      ownerUserId,
      kind: 'payId',
      payIdType: 'email',
      maskedDisplay: 'm***@example.com',
      fingerprint: 'unlabeled-fingerprint',
      ...encrypted,
    })
    return {
      labeledId: insertedLabeledId,
      unlabeledId: insertedUnlabeledId,
    }
  })

  await t.run(async (ctx) => {
    await runToCompletion(
      ctx,
      components.migrations,
      internal.migrations.backfillPaymentDestinationSearchLabel,
    )
  })

  await expect(
    t.run(async (ctx) => ({
      labeled: await ctx.db.get('paymentDestinations', labeledId),
      unlabeled: await ctx.db.get('paymentDestinations', unlabeledId),
    })),
  ).resolves.toMatchObject({
    labeled: { searchLabel: 'Everyday' },
    unlabeled: { searchLabel: '' },
  })

  await t.run(async (ctx) => {
    await runToCompletion(
      ctx,
      components.migrations,
      internal.migrations.backfillPaymentDestinationSearchLabel,
    )
  })
  await expect(
    t.run(async (ctx) => ctx.db.get('paymentDestinations', labeledId)),
  ).resolves.toMatchObject({ searchLabel: 'Everyday' })
})

test('backfills missing user search text from name and optional username', async () => {
  const t = convexTest(legacySchema, modules)
  migrationComponent.register(t)

  const { namedUserId, usernameUserId } = await t.run(async (ctx) => {
    const insertedNamedUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'issuer|searchable-user',
      clerkUserId: 'searchable-user',
      email: 'searchable@example.com',
      name: 'Searchable User',
    })
    const insertedUsernameUserId = await ctx.db.insert('users', {
      tokenIdentifier: 'issuer|username-user',
      clerkUserId: 'username-user',
      email: 'username@example.com',
      name: 'Username User',
      username: 'payme-user',
    })
    return {
      namedUserId: insertedNamedUserId,
      usernameUserId: insertedUsernameUserId,
    }
  })

  await t.run(async (ctx) => {
    await runToCompletion(
      ctx,
      components.migrations,
      internal.migrations.backfillUserSearchText,
    )
  })

  await expect(
    t.run(async (ctx) => ({
      namedUser: await ctx.db.get('users', namedUserId),
      usernameUser: await ctx.db.get('users', usernameUserId),
    })),
  ).resolves.toMatchObject({
    namedUser: { searchText: 'Searchable User' },
    usernameUser: { searchText: 'Username User payme-user' },
  })
})
