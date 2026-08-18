import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'prettier'
import { z } from 'zod'

import { paymentDestinationInputValidator } from '../convex/validators/paymentDestinations'
import type { PaymentDestinationInput } from '../convex/validators/paymentDestinations'
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
const webhookConfirmation =
  'https://docs.zeptopayments.com/docs/setting-up-your-webhooks'
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

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error('A live certification command returned invalid JSON.')
  }
}

function providerLimitation(
  requirement:
    | 'repeated-webhook-delivery'
    | 'missed-webhook-recovery'
    | 'duplicate-webhook-recovery'
    | 'reordered-webhook-recovery',
  deterministicEvidence: string[],
): LiveCertificationScenario {
  return {
    requirement,
    result: 'provider_limitation',
    evidence:
      'Zepto documents delivery semantics but exposes no API control that deterministically forces this delivery pattern.',
    deterministicEvidence,
    zeptoConfirmation: webhookConfirmation,
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
  const workflowAgreementId = requiredEnvironment(
    'PAYTO_PAYMENT_LIVE_WORKFLOW_AGREEMENT_ID',
  )
  const workflowPaymentId = requiredEnvironment(
    'PAYTO_PAYMENT_LIVE_WORKFLOW_PAYMENT_ID',
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
    state: string,
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

  const settled = await createScenarioPayment('settled', {
    simulate: 'auto_settle',
  })
  await waitForState(settled.input, 'settled')
  observations.set('exactly-one-creation-and-authoritative-settlement', {
    requirement: 'exactly-one-creation-and-authoritative-settlement',
    result: 'passed',
    evidence: `Payment fingerprint ${opaqueFingerprint(settled.providerUid)}: one create POST and authoritative GET-confirmed settlement.`,
  })

  const ensureArgs = JSON.stringify({
    payToAgreementId: workflowAgreementId,
    observedAt: Date.now(),
  })
  const firstEnsure = parseJson<{ kind: string; payToPaymentId?: string }>(
    runCommand('bunx', ['convex', 'run', 'payToPayments:ensure', ensureArgs]),
  )
  const secondEnsure = parseJson<{ kind: string; payToPaymentId?: string }>(
    runCommand('bunx', ['convex', 'run', 'payToPayments:ensure', ensureArgs]),
  )
  const operations = parseJson<
    Array<{ payToPaymentId?: string; operationKind?: string }>
  >(
    runCommand('bunx', [
      'convex',
      'data',
      'payToPaymentOperations',
      '--limit',
      '100',
      '--format',
      'json',
    ]),
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
  observations.set('repeated-activation', {
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
  observations.set('create-response-loss-and-same-uid-get-recovery', {
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
  observations.set('retryable-failure-and-retry', {
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
  observations.set('non-retryable-failure', {
    requirement: 'non-retryable-failure',
    result: 'passed',
    evidence: `Payment fingerprint ${opaqueFingerprint(nonRetryable.providerUid)} reached GET-confirmed non-retryable failure.`,
  })

  const pending = await createScenarioPayment('pending', {
    simulate: 'auto_settle',
    delaySeconds: 30,
  })
  await waitForState(pending.input, 'pending', 25_000)
  observations.set('pending', {
    requirement: 'pending',
    result: 'passed',
    evidence: `Payment fingerprint ${opaqueFingerprint(pending.providerUid)} was observed pending by authoritative GET without a second create.`,
  })

  const investigation = await createScenarioPayment('investigation', {
    simulate: 'requires_investigation',
  })
  await waitForState(investigation.input, 'under_investigation')
  observations.set('under-investigation', {
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
    waitForState(mixedFailed.input, 'failed'),
  ])
  observations.set('multi-payer-mixed-outcomes', {
    requirement: 'multi-payer-mixed-outcomes',
    result: 'passed',
    evidence: `Independent Payment fingerprints ${opaqueFingerprint(mixedSettled.providerUid)} and ${opaqueFingerprint(mixedFailed.providerUid)} reached settled and failed outcomes; deterministic Money Request projection evidence remains separately certified.`,
  })

  observations.set(
    'repeated-webhook-delivery',
    providerLimitation('repeated-webhook-delivery', [
      'convex/zeptoWebhook.test.ts',
      'convex/payToPayments.test.ts',
    ]),
  )
  observations.set(
    'missed-webhook-recovery',
    providerLimitation('missed-webhook-recovery', [
      'convex/payToPaymentReconciliation.test.ts',
    ]),
  )
  observations.set(
    'duplicate-webhook-recovery',
    providerLimitation('duplicate-webhook-recovery', [
      'convex/zeptoWebhook.test.ts',
    ]),
  )
  observations.set(
    'reordered-webhook-recovery',
    providerLimitation('reordered-webhook-recovery', [
      'convex/zeptoWebhook.test.ts',
      'convex/payToPayments.test.ts',
    ]),
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
