import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'prettier'
import { z } from 'zod'

import type { Id } from '../convex/_generated/dataModel'
import { paymentDestinationInputValidator } from '../convex/validators/paymentDestinations'
import type { PaymentDestinationInput } from '../convex/validators/paymentDestinations'
import type { ProviderPayToPaymentState } from '../convex/validators/payToPayments'
import {
  createAgreement,
  getAgreementByUid,
} from '../convex/lib/zepto/agreement'
import { createZeptoClient } from '../convex/lib/zepto/client'
import { ZeptoClientError } from '../convex/lib/zepto/error'
import {
  createPayment,
  getPaymentLifecycleByUid,
  retryPayment,
} from '../convex/lib/zepto/payment'
import type { SandboxPaymentSimulation } from '../convex/lib/zepto/payment'
import {
  LIVE_CERTIFICATION_REQUIREMENTS,
  buildLiveCertificationReport,
} from './certification/pay-to-payment-live'
import type { LiveCertificationScenario } from './certification/pay-to-payment-live'
import {
  PAYTO_PAYMENT_API_VERSION,
  resolveCertificationBindings,
} from './certification/pay-to-payment'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutput = 'docs/certification/pay-to-payment-live.md'
const paymentAmountCents = 1

const templateAgreementValidator = z.object({
  creditor: z.object({
    party_name: z.string().min(1),
    account_identifier: paymentDestinationInputValidator,
  }),
  debtor: z.object({
    party_name: z.string().min(1),
    account_identifier: paymentDestinationInputValidator,
  }),
})

const payToAgreementIdValidator = z
  .string()
  .regex(/^[a-z0-9]{32}$/)
  .transform((value) => value as Id<'payToAgreements'>)
const payToPaymentIdValidator = z
  .string()
  .regex(/^[a-z0-9]{32}$/)
  .transform((value) => value as Id<'payToPayments'>)
const ensureResultValidator = z.object({
  kind: z.string(),
  payToPaymentId: payToPaymentIdValidator.optional(),
})
const paymentOperationsValidator = z.array(
  z.object({
    payToPaymentId: payToPaymentIdValidator.optional(),
    operationKind: z.string().optional(),
  }),
)

function requiredEnvironment(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function argumentValue(name: string) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`)
  }
  return value
}

function runCommand(executable: string, args: ReadonlyArray<string>) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, CI: '1' },
  })
  if (result.status !== 0) {
    throw new Error(
      `Live certification command failed: ${executable} ${args[0] ?? ''}`,
    )
  }
  return result.stdout.trim()
}

function inspectRepository() {
  return {
    clean: runCommand('git', ['status', '--porcelain']) === '',
    commit: runCommand('git', ['rev-parse', 'HEAD']),
  }
}

function opaqueFingerprint(value: string) {
  return createHash('sha256').update(value).digest('base64url').slice(0, 16)
}

function sandboxDebtor(
  label: string,
  accountIdentifier: PaymentDestinationInput,
  certifiedCommit: string,
) {
  if (accountIdentifier.type !== 'bban') {
    throw new Error(
      'Live certification requires a BBAN sandbox Agreement template.',
    )
  }
  const [bsb] = accountIdentifier.value.split('-', 1)
  if (!bsb) {
    throw new Error('Live certification sandbox BBAN template is invalid.')
  }
  const accountNumber = BigInt(
    `0x${createHash('sha256').update(`${certifiedCommit}:${label}`).digest('hex').slice(0, 12)}`,
  )
    .toString()
    .slice(-9)
    .padStart(9, '0')
  return {
    name: `PayMe Sandbox ${opaqueFingerprint(label).slice(0, 8)}`,
    accountIdentifier: {
      type: 'bban' as const,
      value: `${bsb}-${accountNumber}`,
    },
  }
}

function uniqueUid(label: string) {
  return `payme47_${Date.now().toString(36)}_${label}_${crypto.randomUUID().slice(0, 8)}`
}

function sleep(delayMs: number) {
  return new Promise((done) => setTimeout(done, delayMs))
}

async function poll<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  description: string,
  timeoutMs = 45_000,
) {
  const deadline = Date.now() + timeoutMs
  let latest = await read()
  while (!accept(latest) && Date.now() < deadline) {
    await sleep(1_000)
    latest = await read()
  }
  if (!accept(latest)) throw new Error(`Timed out waiting for ${description}.`)
  return latest
}

function parseJson<T>(raw: string, validator: z.ZodType<T>): T {
  try {
    return validator.parse(JSON.parse(raw))
  } catch {
    throw new Error('A live certification command returned invalid JSON.')
  }
}

function incompleteScenario(
  requirement: (typeof LIVE_CERTIFICATION_REQUIREMENTS)[number],
  evidence: string,
  deterministicEvidence: string[],
  missingEvidence: string,
): LiveCertificationScenario {
  return {
    requirement,
    result: 'incomplete',
    evidence,
    deterministicEvidence,
    missingEvidence,
  }
}

async function main() {
  process.chdir(repositoryRoot)

  const initial = inspectRepository()
  if (!initial.clean)
    throw new Error('Live certification requires a clean worktree.')

  const templateAgreementUid = requiredEnvironment(
    'PAYTO_PAYMENT_LIVE_TEMPLATE_AGREEMENT_UID',
  )
  const workflowAgreementId = payToAgreementIdValidator.parse(
    requiredEnvironment('PAYTO_PAYMENT_LIVE_WORKFLOW_AGREEMENT_ID'),
  )
  const workflowPaymentId = payToPaymentIdValidator.parse(
    requiredEnvironment('PAYTO_PAYMENT_LIVE_WORKFLOW_PAYMENT_ID'),
  )
  const outputPath = resolve(argumentValue('--output') ?? defaultOutput)
  const bindings = resolveCertificationBindings({
    environment: process.env.ZEPTO_ENVIRONMENT,
    configurationFingerprint:
      process.env.PAYTO_PAYMENT_CONFIGURATION_FINGERPRINT,
    sandboxCredential: process.env.ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN,
  })
  if (bindings.environment !== 'sandbox') {
    throw new Error('Live PayTo Payment certification is sandbox-only.')
  }
  const deployedEnvironment = runCommand('bunx', [
    'convex',
    'env',
    'get',
    'ZEPTO_ENVIRONMENT',
  ])
  const deployedCommit = runCommand('bunx', [
    'convex',
    'env',
    'get',
    'PAYME_RELEASE_COMMIT',
  ])
  const deployedConfigurationFingerprint = runCommand('bunx', [
    'convex',
    'env',
    'get',
    'PAYTO_PAYMENT_CONFIGURATION_FINGERPRINT',
  ])
  if (
    deployedEnvironment !== bindings.environment ||
    deployedCommit !== initial.commit ||
    deployedConfigurationFingerprint !== bindings.configurationFingerprint
  ) {
    throw new Error(
      'The selected Convex deployment does not match the live certification bindings.',
    )
  }
  const accessToken = requiredEnvironment('ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN')

  const baseClient = createZeptoClient({
    environment: 'sandbox',
    accessToken,
    maxRetries: 0,
  })
  const { data: templateData } = await baseClient.payTo.GET(
    '/payto/agreements/{agreement_uid}',
    { params: { path: { agreement_uid: templateAgreementUid } } },
  )
  const template = templateAgreementValidator.parse(templateData?.data)

  async function createActiveAgreement(label: string) {
    const providerUid = uniqueUid(`agreement_${label}`)
    await createAgreement(baseClient, {
      providerUid,
      amountCents: paymentAmountCents,
      description: `PayMe live certification ${initial.commit.slice(0, 12)}`,
      creditor: {
        name: template.creditor.party_name,
        accountIdentifier: template.creditor.account_identifier,
      },
      debtor: sandboxDebtor(
        label,
        template.debtor.account_identifier,
        initial.commit,
      ),
    })
    await poll(
      () => getAgreementByUid(baseClient, providerUid),
      (agreement) => agreement.state === 'active',
      'sandbox Agreement activation',
    )
    return providerUid
  }

  function paymentInput(agreementProviderUid: string, providerUid: string) {
    return {
      providerUid,
      agreementProviderUid,
      amountCents: paymentAmountCents,
      priority: 'unattended' as const,
    }
  }

  async function createScenarioPayment(
    label: string,
    sandboxSimulation: SandboxPaymentSimulation,
  ) {
    const agreementProviderUid = await createActiveAgreement(label)
    const providerUid = uniqueUid(`payment_${label}`)
    const input = paymentInput(agreementProviderUid, providerUid)
    let createPostAttempts = 0
    const client = createZeptoClient({
      environment: 'sandbox',
      accessToken,
      maxRetries: 0,
      onAttempt: ({ method, path }) => {
        if (method === 'POST' && path === '/payto/payments')
          createPostAttempts += 1
      },
    })
    await createPayment(client, { ...input, sandboxSimulation })
    if (createPostAttempts !== 1) {
      throw new Error('A live scenario did not issue exactly one create POST.')
    }
    return { input, providerUid, createPostAttempts }
  }

  async function waitForState(
    input: ReturnType<typeof paymentInput>,
    state: ProviderPayToPaymentState,
    timeoutMs?: number,
  ) {
    return await poll(
      () => getPaymentLifecycleByUid(baseClient, input),
      (result) => result.providerState === state,
      `Payment state ${state}`,
      timeoutMs,
    )
  }

  const observations = new Map<
    (typeof LIVE_CERTIFICATION_REQUIREMENTS)[number],
    LiveCertificationScenario
  >()

  function recordObservation(observation: LiveCertificationScenario) {
    if (observations.has(observation.requirement)) {
      throw new Error(`Duplicate live observation: ${observation.requirement}`)
    }
    observations.set(observation.requirement, observation)
  }

  const settled = await createScenarioPayment('settled', {
    simulate: 'auto_settle',
  })
  await waitForState(settled.input, 'settled')
  recordObservation({
    requirement: 'exactly-one-creation-and-authoritative-settlement',
    result: 'incomplete',
    evidence: `Payment fingerprint ${opaqueFingerprint(settled.providerUid)}: the adapter issued one create POST and authoritative GET confirmed settlement.`,
    deterministicEvidence: ['convex/payToPayments.test.ts'],
    missingEvidence:
      'One live workflow activation proving durable immutable intent through settlement',
  })

  const ensureArgs = JSON.stringify({
    payToAgreementId: workflowAgreementId,
    observedAt: Date.now(),
  })
  const firstEnsure = parseJson(
    runCommand('bunx', ['convex', 'run', 'payToPayments:ensure', ensureArgs]),
    ensureResultValidator,
  )
  const secondEnsure = parseJson(
    runCommand('bunx', ['convex', 'run', 'payToPayments:ensure', ensureArgs]),
    ensureResultValidator,
  )
  const operations = parseJson(
    runCommand('bunx', [
      'convex',
      'data',
      'payToPaymentOperations',
      '--limit',
      '100',
      '--format',
      'json',
    ]),
    paymentOperationsValidator,
  )
  const workflowCreateCount = operations.filter(
    (operation) =>
      operation.payToPaymentId === workflowPaymentId &&
      operation.operationKind === 'create',
  ).length
  if (
    firstEnsure.kind !== 'matched' ||
    secondEnsure.kind !== 'matched' ||
    firstEnsure.payToPaymentId !== workflowPaymentId ||
    secondEnsure.payToPaymentId !== workflowPaymentId ||
    workflowCreateCount !== 1
  ) {
    throw new Error(
      'Repeated activation did not preserve one workflow Payment.',
    )
  }
  recordObservation({
    requirement: 'repeated-activation',
    result: 'passed',
    evidence: `Workflow Payment fingerprint ${opaqueFingerprint(workflowPaymentId)} matched twice with one durable create operation.`,
  })

  const lostAgreementUid = await createActiveAgreement('response_loss')
  const lostProviderUid = uniqueUid('payment_response_loss')
  const lostInput = paymentInput(lostAgreementUid, lostProviderUid)
  let discardedResponse = false
  const responseLossClient = createZeptoClient({
    environment: 'sandbox',
    accessToken,
    maxRetries: 0,
    fetch: async (request) => {
      const response = await fetch(request)
      if (
        !discardedResponse &&
        request.method === 'POST' &&
        new URL(request.url).pathname === '/payto/payments'
      ) {
        discardedResponse = true
        throw new TypeError(
          'Deliberately discarded live certification response',
        )
      }
      return response
    },
  })
  try {
    await createPayment(responseLossClient, {
      ...lostInput,
      sandboxSimulation: { simulate: 'auto_settle' },
    })
    throw new Error('The deliberate create-response loss was not observed.')
  } catch (error) {
    if (!(error instanceof ZeptoClientError) || error.kind !== 'network') {
      throw error
    }
  }
  await waitForState(lostInput, 'settled')
  recordObservation({
    requirement: 'create-response-loss-and-same-uid-get-recovery',
    result: 'passed',
    evidence: `Payment fingerprint ${opaqueFingerprint(lostProviderUid)} recovered by same-UID GET after deliberate create-response loss.`,
  })

  const retryable = await createScenarioPayment('retryable', {
    simulate: 'insufficient_funds',
  })
  const retryableFailure = await waitForState(retryable.input, 'failed')
  if (retryableFailure.failure?.retryable !== true) {
    throw new Error('Zepto did not mark the retryable scenario retryable.')
  }
  await retryPayment(baseClient, {
    providerUid: retryable.providerUid,
    sandboxSimulation: { simulate: 'auto_settle' },
  })
  await waitForState(retryable.input, 'settled')
  recordObservation({
    requirement: 'retryable-failure-and-retry',
    result: 'passed',
    evidence: `Payment fingerprint ${opaqueFingerprint(retryable.providerUid)} failed retryably, retried the same resource, and settled authoritatively.`,
  })

  const nonRetryable = await createScenarioPayment('non_retryable', {
    simulate: 'creditor_account_closed',
  })
  const nonRetryableFailure = await waitForState(nonRetryable.input, 'failed')
  if (nonRetryableFailure.failure?.retryable !== false) {
    throw new Error(
      'Zepto did not mark the non-retryable scenario non-retryable.',
    )
  }
  recordObservation({
    requirement: 'non-retryable-failure',
    result: 'passed',
    evidence: `Payment fingerprint ${opaqueFingerprint(nonRetryable.providerUid)} reached GET-confirmed non-retryable failure.`,
  })

  recordObservation(
    incompleteScenario(
      'pending',
      'Zepto documents pending but the available sandbox simulations did not deterministically hold a Payment pending.',
      ['convex/payToPayments.test.ts'],
      'Direct written Zepto confirmation or a reproducible live pending fixture',
    ),
  )

  const investigation = await createScenarioPayment('investigation', {
    simulate: 'requires_investigation',
  })
  await waitForState(investigation.input, 'under_investigation')
  recordObservation({
    requirement: 'under-investigation',
    result: 'passed',
    evidence: `Payment fingerprint ${opaqueFingerprint(investigation.providerUid)} reached GET-confirmed under-investigation state without a second create.`,
  })

  const mixedSettled = await createScenarioPayment('mixed_settled', {
    simulate: 'auto_settle',
  })
  const mixedFailed = await createScenarioPayment('mixed_failed', {
    simulate: 'investigate_and_fail',
  })
  await Promise.all([
    waitForState(mixedSettled.input, 'settled'),
    waitForState(mixedFailed.input, 'failed', 120_000),
  ])
  recordObservation({
    requirement: 'multi-payer-mixed-outcomes',
    result: 'incomplete',
    evidence: `Independent Payment fingerprints ${opaqueFingerprint(mixedSettled.providerUid)} and ${opaqueFingerprint(mixedFailed.providerUid)} reached settled and failed provider outcomes.`,
    deterministicEvidence: ['convex/payToPayments.test.ts'],
    missingEvidence:
      'One live multi-Payer Money Request projecting both provider outcomes',
  })

  recordObservation(
    incompleteScenario(
      'repeated-webhook-delivery',
      'The live run did not force Zepto to deliver the same webhook repeatedly.',
      ['convex/zeptoWebhook.test.ts', 'convex/payToPayments.test.ts'],
      'Direct written Zepto confirmation or a reproducible repeated-delivery fixture',
    ),
  )
  recordObservation(
    incompleteScenario(
      'missed-webhook-recovery',
      'The live run did not force Zepto to omit a webhook for a workflow Payment.',
      ['convex/payToPayments.test.ts'],
      'Direct written Zepto confirmation or a reproducible missed-delivery fixture',
    ),
  )
  recordObservation(
    incompleteScenario(
      'duplicate-webhook-recovery',
      'The live run did not force duplicate Zepto webhook delivery.',
      ['convex/zeptoWebhook.test.ts'],
      'Direct written Zepto confirmation or a reproducible duplicate-delivery fixture',
    ),
  )
  recordObservation(
    incompleteScenario(
      'reordered-webhook-recovery',
      'The live run did not force reordered Zepto webhook delivery.',
      ['convex/zeptoWebhook.test.ts', 'convex/payToPayments.test.ts'],
      'Direct written Zepto confirmation or a reproducible reordered-delivery fixture',
    ),
  )

  const scenarios = LIVE_CERTIFICATION_REQUIREMENTS.map((requirement) => {
    const observation = observations.get(requirement)
    if (!observation)
      throw new Error(`Missing live observation: ${requirement}`)
    return observation
  })
  const final = inspectRepository()
  if (!final.clean || final.commit !== initial.commit) {
    throw new Error('The worktree or commit changed during live certification.')
  }

  const report = await format(
    buildLiveCertificationReport({
      certifiedCommit: initial.commit,
      evidenceDate: new Date().toISOString().slice(0, 10),
      environment: 'sandbox',
      apiVersion: PAYTO_PAYMENT_API_VERSION,
      configurationFingerprint: bindings.configurationFingerprint,
      credentialFingerprint: bindings.credentialFingerprint,
      worktreeClean: final.clean,
      scenarios,
    }),
    { parser: 'markdown' },
  )

  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, report, 'utf8')
  console.log(`[PayTo Payment live certification] Wrote ${outputPath}`)
}

try {
  await main()
} catch (error) {
  if (error instanceof ZeptoClientError) {
    console.error(
      `[PayTo Payment live certification] Zepto request failed safely: ${JSON.stringify(
        {
          kind: error.kind,
          status: error.status,
          method: error.method,
          path: error.path,
        },
      )}`,
    )
  } else if (error instanceof z.ZodError) {
    console.error(
      '[PayTo Payment live certification] Sandbox Agreement template validation failed safely.',
    )
  } else {
    console.error(
      `[PayTo Payment live certification] ${error instanceof Error ? error.message : 'Live certification failed safely.'}`,
    )
  }
  process.exitCode = 1
}
