/// <reference types="vite/client" />

import type { UserIdentity } from 'convex/server'
import { convexTest } from 'convex-test'
import { afterEach, expect, test, vi } from 'vitest'

import { api, internal } from './_generated/api'
import {
  failProductionRolloutClosed,
  ROLLOUT_CLEAN_PERIOD_MS,
} from './lib/payToPaymentRollout'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

afterEach(() => {
  vi.restoreAllMocks()
  process.env.ZEPTO_ENVIRONMENT = 'sandbox'
})

const operatorIdentity = {
  tokenIdentifier: 'https://clerk.example.test|rollout_operator',
  subject: 'rollout_operator',
  issuer: 'https://clerk.example.test',
} satisfies UserIdentity

async function setupOperator() {
  const t = convexTest(schema, modules)
  const payerUserId = await t.run(async (ctx) => {
    await ctx.db.insert('users', {
      tokenIdentifier: operatorIdentity.tokenIdentifier,
      clerkUserId: operatorIdentity.subject,
      email: 'rollout-operator@example.test',
      displayName: 'Rollout Operator',
      searchText: 'Rollout Operator',
      roles: ['payment_operator'],
    })
    return await ctx.db.insert('users', {
      tokenIdentifier: 'https://clerk.example.test|rollout_payer',
      clerkUserId: 'rollout_payer',
      email: 'rollout-payer@example.test',
      displayName: 'Rollout Payer',
      searchText: 'Rollout Payer',
      paymentRolloutCohort: 'internal_test',
    })
  })
  return { t, payerUserId, operator: t.withIdentity(operatorIdentity) }
}

function configureProductionRuntime() {
  process.env.PAYME_RELEASE_COMMIT = 'a'.repeat(40)
  process.env.PAYTO_PAYMENT_CONFIGURATION_FINGERPRINT = 'configuration-v1'
  process.env.PAYTO_PAYMENT_CERTIFICATION_FINGERPRINT = 'certification-v1'
  process.env.ZEPTO_ENVIRONMENT = 'production'
  process.env.ZEPTO_PERSONAL_ACCESS_TOKEN = 'production-payment-token'
}

async function recordCleanRolloutDay(
  t: ReturnType<typeof convexTest>,
  observedAt: number,
) {
  await t.mutation(internal.payToPaymentRolloutMonitoring.scan, {
    paginationOpts: {
      numItems: 100,
      cursor: null,
      maximumRowsRead: 100,
      maximumBytesRead: 1_000_000,
    },
    observedAt,
  })
}

test('refuses and audits an unauthenticated rollout change and fails the production gate closed', async () => {
  const t = convexTest(schema, modules)
  await t.run(async (ctx) => {
    await ctx.db.insert('payToPaymentRuntimeGates', {
      environment: 'production',
      mode: 'enabled_for_new_confirmations',
      rolloutStage: 'small_allowlist',
      stageChangedAt: 1_000,
      cleanSince: 1_000,
    })
  })
  vi.spyOn(Date, 'now').mockReturnValue(2_000)

  await expect(
    t.mutation(api.payToPaymentOperators.startRolloutSoak, {
      reason: 'prepare_production_soak',
    }),
  ).resolves.toEqual({ decision: 'refused', code: 'unauthenticated' })

  await expect(
    t.run(async (ctx) => ({
      gate: await ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'production'))
        .unique(),
      actions: await ctx.db
        .query('payToPaymentRolloutActions')
        .withIndex('by_environment_and_requestedAt', (q) =>
          q.eq('environment', 'production'),
        )
        .take(10),
    })),
  ).resolves.toMatchObject({
    gate: {
      mode: 'reconcile_only',
      rolloutStage: 'reconcile_only_soak',
      stageChangedAt: 2_000,
    },
    actions: [
      {
        authentication: 'unauthenticated',
        authorization: 'not_authenticated',
        action: 'start_reconcile_only_soak',
        reason: 'prepare_production_soak',
        decision: 'refused',
        resultCode: 'unauthenticated',
        requestedAt: 2_000,
      },
      {
        authentication: 'system',
        authorization: 'automatic_safety_policy',
        action: 'automatic_safety_stop',
        safetyCause: 'authorization_failure',
        decision: 'authorized',
        resultCode: 'changed',
        requestedAt: 2_000,
      },
    ],
  })
})

test('requires an explicit expansion after seven clean days of reconcile-only soak', async () => {
  const { t, payerUserId, operator } = await setupOperator()
  configureProductionRuntime()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  await expect(
    operator.mutation(api.payToPaymentOperators.startRolloutSoak, {
      reason: 'prepare_production_soak',
    }),
  ).resolves.toEqual({ decision: 'authorized', code: 'changed' })

  const activation = {
    reason: 'begin_limited_rollout' as const,
    allowlistedPayerUserIds: [payerUserId],
    capacityLimits: {
      dailyPaymentCount: 1,
      dailyPaymentValueCents: 12_500,
    },
    certificationReference: 'certification://payment-release-1',
    approvalReferences: {
      engineering: 'approval://engineering/1',
      operations: 'approval://operations/1',
      security: 'approval://security/1',
      legalCompliance: 'approval://legal/1',
      zepto: 'approval://zepto/1',
    },
  }
  clock.mockReturnValue(1_000 + ROLLOUT_CLEAN_PERIOD_MS - 1)
  await expect(
    operator.mutation(
      api.payToPaymentOperators.advanceProductionRollout,
      activation,
    ),
  ).resolves.toEqual({
    decision: 'refused',
    code: 'clean_period_incomplete',
  })
  await expect(
    t.run(async (ctx) =>
      ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'production'))
        .unique(),
    ),
  ).resolves.toMatchObject({
    mode: 'reconcile_only',
    rolloutStage: 'reconcile_only_soak',
  })

  clock.mockReturnValue(1_000 + ROLLOUT_CLEAN_PERIOD_MS)
  await expect(
    operator.mutation(
      api.payToPaymentOperators.advanceProductionRollout,
      activation,
    ),
  ).resolves.toEqual({
    decision: 'refused',
    code: 'clean_period_incomplete',
  })
  for (let cleanDay = 1; cleanDay <= 7; cleanDay += 1) {
    await recordCleanRolloutDay(t, 1_000 + cleanDay * 24 * 60 * 60_000)
  }
  await expect(
    operator.mutation(
      api.payToPaymentOperators.advanceProductionRollout,
      activation,
    ),
  ).resolves.toEqual({
    decision: 'authorized',
    code: 'changed',
    activationId: expect.any(String),
    activationFingerprint: expect.any(String),
  })
  await expect(
    t.run(async (ctx) => ({
      gate: await ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'production'))
        .unique(),
      actions: await ctx.db
        .query('payToPaymentRolloutActions')
        .withIndex('by_environment_and_requestedAt', (q) =>
          q.eq('environment', 'production'),
        )
        .take(10),
    })),
  ).resolves.toMatchObject({
    gate: {
      mode: 'enabled_for_new_confirmations',
      rolloutStage: 'small_allowlist',
      stageChangedAt: 1_000 + ROLLOUT_CLEAN_PERIOD_MS,
      cleanSince: 1_000 + ROLLOUT_CLEAN_PERIOD_MS,
    },
    actions: [
      { action: 'start_reconcile_only_soak', decision: 'authorized' },
      {
        action: 'activate_small_allowlist',
        decision: 'refused',
        resultCode: 'clean_period_incomplete',
      },
      {
        action: 'activate_small_allowlist',
        decision: 'refused',
        resultCode: 'clean_period_incomplete',
      },
      {
        action: 'activate_small_allowlist',
        decision: 'authorized',
        resultCode: 'changed',
        activationId: expect.any(String),
      },
    ],
  })

  const secondPayerUserId = await t.run(async (ctx) =>
    ctx.db.insert('users', {
      tokenIdentifier: 'https://clerk.example.test|rollout_payer_two',
      clerkUserId: 'rollout_payer_two',
      email: 'rollout-payer-two@example.test',
      displayName: 'Rollout Payer Two',
      searchText: 'Rollout Payer Two',
    }),
  )
  clock.mockReturnValue(1_000 + 2 * ROLLOUT_CLEAN_PERIOD_MS)
  for (let cleanDay = 1; cleanDay <= 7; cleanDay += 1) {
    await recordCleanRolloutDay(
      t,
      1_000 + ROLLOUT_CLEAN_PERIOD_MS + cleanDay * 24 * 60 * 60_000,
    )
  }
  await expect(
    operator.mutation(api.payToPaymentOperators.advanceProductionRollout, {
      ...activation,
      reason: 'expand_production_allowlist',
      allowlistedPayerUserIds: [payerUserId, secondPayerUserId],
      capacityLimits: {
        dailyPaymentCount: 2,
        dailyPaymentValueCents: 25_000,
      },
    }),
  ).resolves.toMatchObject({
    decision: 'authorized',
    code: 'changed',
    activationId: expect.any(String),
  })
  await expect(
    t.run(async (ctx) =>
      ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'production'))
        .unique(),
    ),
  ).resolves.toMatchObject({
    mode: 'enabled_for_new_confirmations',
    rolloutStage: 'expanded_allowlist',
    stageChangedAt: 1_000 + 2 * ROLLOUT_CLEAN_PERIOD_MS,
  })
})

test('requires a non-empty small cohort under strict initial caps', async () => {
  const { t, payerUserId, operator } = await setupOperator()
  configureProductionRuntime()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  await operator.mutation(api.payToPaymentOperators.startRolloutSoak, {
    reason: 'prepare_production_soak',
  })
  for (let cleanDay = 1; cleanDay <= 7; cleanDay += 1) {
    await recordCleanRolloutDay(t, 1_000 + cleanDay * 24 * 60 * 60_000)
  }
  clock.mockReturnValue(1_000 + ROLLOUT_CLEAN_PERIOD_MS)
  const activation = {
    reason: 'begin_limited_rollout' as const,
    allowlistedPayerUserIds: [payerUserId],
    capacityLimits: { dailyPaymentCount: 1, dailyPaymentValueCents: 12_500 },
    certificationReference: 'certification://payment-release-1',
    approvalReferences: {
      engineering: 'approval://engineering/1',
      operations: 'approval://operations/1',
      security: 'approval://security/1',
      legalCompliance: 'approval://legal/1',
      zepto: 'approval://zepto/1',
    },
  }

  await expect(
    operator.mutation(api.payToPaymentOperators.advanceProductionRollout, {
      ...activation,
      allowlistedPayerUserIds: [],
    }),
  ).resolves.toEqual({ decision: 'refused', code: 'invalid_transition' })
  const customerPayerUserId = await t.run(async (ctx) =>
    ctx.db.insert('users', {
      tokenIdentifier: 'https://clerk.example.test|customer_rollout_payer',
      clerkUserId: 'customer_rollout_payer',
      email: 'customer-rollout-payer@example.test',
      displayName: 'Customer Rollout Payer',
      searchText: 'Customer Rollout Payer',
    }),
  )
  await expect(
    operator.mutation(api.payToPaymentOperators.advanceProductionRollout, {
      ...activation,
      allowlistedPayerUserIds: [customerPayerUserId],
    }),
  ).resolves.toEqual({ decision: 'refused', code: 'invalid_transition' })
  await expect(
    operator.mutation(api.payToPaymentOperators.advanceProductionRollout, {
      ...activation,
      capacityLimits: {
        dailyPaymentCount: 26,
        dailyPaymentValueCents: 1_000_001,
      },
    }),
  ).resolves.toEqual({ decision: 'refused', code: 'invalid_transition' })
})

test('a safety stop restarts rollout at the small allowlist stage', async () => {
  const { t, payerUserId, operator } = await setupOperator()
  configureProductionRuntime()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  await operator.mutation(api.payToPaymentOperators.startRolloutSoak, {
    reason: 'prepare_production_soak',
  })
  for (let cleanDay = 1; cleanDay <= 7; cleanDay += 1) {
    await recordCleanRolloutDay(t, 1_000 + cleanDay * 24 * 60 * 60_000)
  }
  clock.mockReturnValue(1_000 + ROLLOUT_CLEAN_PERIOD_MS)
  const activation = {
    reason: 'begin_limited_rollout' as const,
    allowlistedPayerUserIds: [payerUserId],
    capacityLimits: { dailyPaymentCount: 1, dailyPaymentValueCents: 12_500 },
    certificationReference: 'certification://payment-release-1',
    approvalReferences: {
      engineering: 'approval://engineering/1',
      operations: 'approval://operations/1',
      security: 'approval://security/1',
      legalCompliance: 'approval://legal/1',
      zepto: 'approval://zepto/1',
    },
  }
  await operator.mutation(
    api.payToPaymentOperators.advanceProductionRollout,
    activation,
  )
  await t.run(async (ctx) =>
    failProductionRolloutClosed(ctx, {
      cause: 'unknown_provider_state',
      observedAt: 1_001 + ROLLOUT_CLEAN_PERIOD_MS,
    }),
  )
  const restartedAt = 1_002 + ROLLOUT_CLEAN_PERIOD_MS
  clock.mockReturnValue(restartedAt)
  await operator.mutation(api.payToPaymentOperators.startRolloutSoak, {
    reason: 'prepare_production_soak',
  })
  for (let cleanDay = 1; cleanDay <= 7; cleanDay += 1) {
    await recordCleanRolloutDay(t, restartedAt + cleanDay * 24 * 60 * 60_000)
  }
  clock.mockReturnValue(restartedAt + ROLLOUT_CLEAN_PERIOD_MS)

  await expect(
    operator.mutation(api.payToPaymentOperators.advanceProductionRollout, {
      ...activation,
      reason: 'expand_production_allowlist',
    }),
  ).resolves.toEqual({ decision: 'refused', code: 'invalid_transition' })
  await expect(
    operator.mutation(
      api.payToPaymentOperators.advanceProductionRollout,
      activation,
    ),
  ).resolves.toMatchObject({ decision: 'authorized', code: 'changed' })
  await expect(
    t.run(async (ctx) =>
      ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'production'))
        .unique(),
    ),
  ).resolves.toMatchObject({ rolloutStage: 'small_allowlist' })
})

test('a material production webhook-verification failure stops rollout through ingress evidence', async () => {
  const t = convexTest(schema, modules)
  await t.run(async (ctx) => {
    await ctx.db.insert('payToPaymentRuntimeGates', {
      environment: 'production',
      mode: 'enabled_for_new_confirmations',
      rolloutStage: 'small_allowlist',
      stageChangedAt: 1_000,
      cleanSince: 1_000,
    })
  })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await t.mutation(internal.payToPaymentRetention.recordRejectedDelivery, {
      environment: 'production',
      reason: 'invalid_signature',
      deliveryId: `delivery-${attempt}`,
      observedAt: 2_000 + attempt,
    })
  }

  await expect(
    t.run(async (ctx) =>
      ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'production'))
        .unique(),
    ),
  ).resolves.toMatchObject({
    mode: 'reconcile_only',
    lastSafetyCause: 'webhook_verification_failure',
  })
})

test('serializes concurrent safety evaluation and retains every triggering cause', async () => {
  const t = convexTest(schema, modules)
  await t.run(async (ctx) => {
    await ctx.db.insert('payToPaymentRuntimeGates', {
      environment: 'production',
      mode: 'enabled_for_new_confirmations',
      rolloutStage: 'expanded_allowlist',
      stageChangedAt: 1_000,
      cleanSince: 1_000,
    })
  })

  await Promise.all([
    t.run(async (ctx) =>
      failProductionRolloutClosed(ctx, {
        cause: 'unknown_provider_state',
        observedAt: 2_000,
      }),
    ),
    t.run(async (ctx) =>
      failProductionRolloutClosed(ctx, {
        cause: 'reconciliation_outage',
        observedAt: 2_001,
      }),
    ),
  ])

  await expect(
    t.run(async (ctx) => ({
      gate: await ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'production'))
        .unique(),
      actions: await ctx.db
        .query('payToPaymentRolloutActions')
        .withIndex('by_environment_and_requestedAt', (q) =>
          q.eq('environment', 'production'),
        )
        .take(10),
    })),
  ).resolves.toMatchObject({
    gate: { mode: 'reconcile_only', rolloutStage: 'reconcile_only_soak' },
    actions: [
      { safetyCause: 'unknown_provider_state' },
      { safetyCause: 'reconciliation_outage' },
    ],
  })
})

test.each([
  'suspected_duplicate_initiation',
  'permanent_uid_invariant_breach',
  'settlement_contradiction',
  'projection_inconsistency',
  'authorization_failure',
  'unknown_provider_state',
  'certification_mismatch',
  'unresolved_creation_ambiguity',
  'unresolved_retry_ambiguity',
  'webhook_verification_failure',
  'reconciliation_outage',
  'cap_breach',
] as const)('automatically fails production closed for %s', async (cause) => {
  const t = convexTest(schema, modules)
  await t.run(async (ctx) => {
    await ctx.db.insert('payToPaymentRuntimeGates', {
      environment: 'production',
      mode: 'enabled_for_new_confirmations',
      rolloutStage: 'expanded_allowlist',
      stageChangedAt: 1_000,
      cleanSince: 1_000,
    })
  })

  await t.run(async (ctx) =>
    failProductionRolloutClosed(ctx, { cause, observedAt: 2_000 }),
  )

  await expect(
    t.run(async (ctx) =>
      ctx.db
        .query('payToPaymentRuntimeGates')
        .withIndex('by_environment', (q) => q.eq('environment', 'production'))
        .unique(),
    ),
  ).resolves.toMatchObject({
    mode: 'reconcile_only',
    rolloutStage: 'reconcile_only_soak',
    lastSafetyCause: cause,
  })
})
