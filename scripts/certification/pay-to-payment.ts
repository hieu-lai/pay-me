import { createHash } from 'node:crypto'

export const PAYTO_PAYMENT_API_VERSION = '20260101' as const

export const MANDATORY_CERTIFICATION_REQUIREMENTS = [
  'exactly-once-intent-and-dispatch',
  'creation-ambiguity',
  'lifecycle-truth',
  'retry-policy',
  'webhooks',
  'projections',
  'gates',
  'authorization',
  'redaction',
  'retention',
  'multi-payer-isolation',
] as const

export type CertificationRequirement =
  (typeof MANDATORY_CERTIFICATION_REQUIREMENTS)[number]

export const CERTIFICATION_COMMANDS = [
  {
    id: 'formatting',
    displayCommand: 'bun run check:certification',
    executable: 'bun',
    args: ['run', 'check:certification'],
  },
  {
    id: 'linting',
    displayCommand: 'bun run lint',
    executable: 'bun',
    args: ['run', 'lint'],
  },
  {
    id: 'type-checking',
    displayCommand: 'bun run typecheck',
    executable: 'bun',
    args: ['run', 'typecheck'],
  },
  {
    id: 'complete-test-suite',
    displayCommand: 'bun run test',
    executable: 'bun',
    args: ['run', 'test'],
  },
  {
    id: 'production-build',
    displayCommand: 'bun run build',
    executable: 'bun',
    args: ['run', 'build'],
  },
] as const satisfies ReadonlyArray<{
  id: string
  displayCommand: string
  executable: string
  args: ReadonlyArray<string>
}>

export type CertificationCommandId =
  (typeof CERTIFICATION_COMMANDS)[number]['id']

type CertificationEvidence = {
  path: string
  testNames: ReadonlyArray<string>
}

type CertificationScenario = {
  area: string
  requirements: ReadonlyArray<CertificationRequirement>
  evidence: ReadonlyArray<CertificationEvidence>
  deterministicDrill: string
  safetyOutcome: string
}

export const CERTIFICATION_SCENARIOS: ReadonlyArray<CertificationScenario> = [
  {
    area: 'Exactly-once intent and provider dispatch',
    requirements: ['exactly-once-intent-and-dispatch'],
    evidence: [
      {
        path: 'convex/payToPayments.test.ts',
        testNames: [
          'replayed and concurrent confirmation converges on the original PayTo Payment identity',
          'allocates typed create work and immutable fingerprints before dispatch',
          'does not hide another POST when Zepto returns 500',
          'dispatches one provider POST for one authorized retry operation',
        ],
      },
    ],
    deterministicDrill:
      'Repeated and concurrent confirmation, worker crashes, stale leases, and create/retry transport failures cross the production Payment interface and adapter seam.',
    safetyOutcome:
      'One immutable intent, permanent provider UID, durable operation identity, and at most one POST per semantic authorization.',
  },
  {
    area: 'Creation ambiguity and recovery',
    requirements: ['creation-ambiguity'],
    evidence: [
      {
        path: 'convex/payToPayments.test.ts',
        testNames: [
          'recovers an ambiguous create outcome through authoritative same-UID GET',
          'authoritative absence unlocks only two same-UID recovery POSTs',
          'ends unresolved creation recovery at fifteen minutes',
        ],
      },
    ],
    deterministicDrill:
      'Lost responses, duplicate UID, provider absence, malformed success, and bounded same-UID recovery use explicit clocks and normalized adapter evidence.',
    safetyOutcome:
      'Ambiguity reconciles by GET and never allocates a replacement UID or an unbounded POST loop.',
  },
  {
    area: 'Authoritative lifecycle truth',
    requirements: ['lifecycle-truth'],
    evidence: [
      {
        path: 'convex/payToPayments.test.ts',
        testNames: [
          'projects paid only when a per-UID GET confirms settlement',
          'preserves the last confirmed lifecycle when GET returns an unknown state',
          'retains paid counts and raises critical attention after a settlement contradiction',
          'settles from scheduled GET even when no webhook is delivered',
        ],
      },
    ],
    deterministicDrill:
      'Validated GET evidence covers every safe lifecycle, unknown states, missed webhooks, outages, and post-settlement contradictions.',
    safetyOutcome:
      'GET is authoritative, settlement is absorbing, and provisional or unknown evidence cannot rewrite confirmed truth.',
  },
  {
    area: 'Conservative retry policy',
    requirements: ['retry-policy'],
    evidence: [
      {
        path: 'convex/payToPayments.test.ts',
        testNames: [
          'stops before a seventh retry-endpoint call',
          'stops after three accepted-or-possibly-accepted retry submissions',
          'locks an ambiguously acknowledged retry and requires attention when GET still sees failed',
          'schedules the first retry fifteen minutes after a fresh retryable failure',
          'stops retry recovery when the Agreement is no longer valid',
        ],
      },
    ],
    deterministicDrill:
      'Fake-clock drills exercise fresh-GET eligibility, fixed backoff, agreement expiry, rolling and lifetime budgets, cooldown, concurrency, and ambiguous acknowledgement.',
    safetyOutcome:
      'Only GET-confirmed retryable failure can progress; ambiguous retry acknowledgement locks automatic replay.',
  },
  {
    area: 'Authenticated webhook intake',
    requirements: ['webhooks'],
    evidence: [
      {
        path: 'convex/lib/zepto/webhook.test.ts',
        testNames: ['verifies the exact raw body bytes'],
      },
      {
        path: 'convex/zeptoWebhook.test.ts',
        testNames: [
          'durably observes mixed PayTo Agreement and PayTo Payment events and immediately reconciles both',
          'deduplicates replayed, reordered, and conflicting PayTo Payment events',
          'returns 500 when durable webhook intake fails',
          'returns bounded security telemetry for invalid authentication',
        ],
      },
    ],
    deterministicDrill:
      'Exact-byte HMAC, stale/forged signatures, delivery and event replay, reordering, mixed resources, unsupported events, and storage failure cross shared ingress.',
    safetyOutcome:
      'Only durably accepted authenticated evidence is acknowledged; events schedule GET without becoming lifecycle authority.',
  },
  {
    area: 'Payer and Money Request projections',
    requirements: ['projections', 'multi-payer-isolation'],
    evidence: [
      {
        path: 'convex/payToPayments.test.ts',
        testNames: [
          'keeps exact mixed-Payer counts and converges simultaneous settlements atomically',
          'keeps retry work isolated from a sibling Payer Payment',
          'signals projection inconsistencies through critical and aggregate telemetry',
        ],
      },
    ],
    deterministicDrill:
      'Mixed independent Payer outcomes and simultaneous transitions update production projections in real Convex transactions.',
    safetyOutcome:
      'Counts remain exact and non-negative, sibling truth remains isolated, and the Money Request is paid only when every Payer is paid.',
  },
  {
    area: 'Production gates and automatic safety stops',
    requirements: ['gates'],
    evidence: [
      {
        path: 'convex/payToPayments.test.ts',
        testNames: [
          'defaults the runtime gate to disabled without establishing an intent',
          'revalidates every pinned production prerequisite immediately before dispatch',
          'reserves production count and value exposure transactionally under concurrent establishment',
        ],
      },
      {
        path: 'convex/payToPaymentRollout.test.ts',
        testNames: [
          'requires an explicit expansion after seven clean days of reconcile-only soak',
          'a material production webhook-verification failure stops rollout through ingress evidence',
          'serializes concurrent safety evaluation and retains every triggering cause',
        ],
      },
    ],
    deterministicDrill:
      'Default denial, cutoff and allowlist admission, concurrent caps, prerequisite drift, staged rollout, and safety causes cross the durable gate boundary.',
    safetyOutcome:
      'Money-moving dispatch fails closed while webhook intake and GET reconciliation remain available for started Payments.',
  },
  {
    area: 'Operator authorization and policy-bound recovery',
    requirements: ['authorization'],
    evidence: [
      {
        path: 'convex/payToPaymentOperators.test.ts',
        testNames: [
          'refuses unauthenticated access to Payment diagnostics',
          'rejects impersonation, lifecycle forcing, and unbounded reasons at the public boundary',
          'routes resume through Payment policy without clearing attention or changing lifecycle truth',
          'lets a Payment operator request immediate GET reconciliation and audits the server-derived actor',
        ],
      },
    ],
    deterministicDrill:
      'Unauthenticated, insufficient-role, impersonation, forced-state, immediate-GET, no-op, and safe-resume requests cross public operator functions.',
    safetyOutcome:
      'Server-derived identity and module policy authorize recovery; every request leaves bounded audit evidence.',
  },
  {
    area: 'Evidence redaction and diagnostic safety',
    requirements: ['redaction'],
    evidence: [
      {
        path: 'convex/payToPaymentOperators.test.ts',
        testNames: [
          'returns bounded operational summaries without routing, auth, or lease secrets',
        ],
      },
      {
        path: 'convex/payToPayments.test.ts',
        testNames: [
          'drops free-form provider failure codes at the Payment evidence seam',
          'classifies free-form provider states before durable evidence',
          'drops free-form provider failure codes at the retry evidence seam',
        ],
      },
    ],
    deterministicDrill:
      'Representative routing ciphertext, auth material, lease tokens, raw states, and provider failure detail are driven through diagnostics and evidence seams.',
    safetyOutcome:
      'Documents, diagnostics, telemetry, and this manifest retain only allowlisted normalized evidence and fingerprints.',
  },
  {
    area: 'Bounded evidence retention',
    requirements: ['retention'],
    evidence: [
      {
        path: 'convex/payToPaymentRetention.test.ts',
        testNames: [
          'deletes only category-expired records at the seven-year, 90-day, and 30-day boundaries',
          'bounds each cleanup pass and schedules resumable continuation',
          'retired Payment identity prevents duplicate initiation after audit deletion',
        ],
      },
    ],
    deterministicDrill:
      'Explicit clocks cross calendar and category boundaries while bounded cleanup preserves permanent duplicate-prevention identity.',
    safetyOutcome:
      'Audit evidence, mechanics, and rejected-delivery metadata follow their distinct retention periods without weakening exactly-once safety.',
  },
]

type CertificationResult = {
  id: CertificationCommandId
  displayCommand: string
  exitCode: number
}

export type CertificationInput = {
  certifiedCommit: string
  evidenceDate: string
  environment: string
  apiVersion: string
  configurationFingerprint: string
  credentialFingerprint: string
  worktreeClean: boolean
  results: ReadonlyArray<CertificationResult>
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function evidenceIsRunnable(source: string, testName: string) {
  const escapedName = escapeRegExp(testName)
  const declaration = new RegExp(
    String.raw`(?:test|it)(?:\.each\([^)]*\))?\s*\(\s*(['"\x60])${escapedName}\1`,
  )
  if (!declaration.test(source)) return false

  const disabled = new RegExp(
    String.raw`(?:test|it)\s*\.\s*(?:skip|todo)\s*\(\s*(['"\x60])${escapedName}\1`,
  )
  if (disabled.test(source)) return false

  const nameIndex = source.indexOf(testName)
  const nearbyDeclaration = source.slice(
    Math.max(0, nameIndex - 100),
    nameIndex + testName.length + 200,
  )
  return !/quarantin(?:e|ed)\s*[:=]\s*true/i.test(nearbyDeclaration)
}

export async function verifyCertificationEvidence(
  readText: (path: string) => Promise<string>,
) {
  const covered = new Set(
    CERTIFICATION_SCENARIOS.flatMap(({ requirements }) => requirements),
  )
  for (const requirement of MANDATORY_CERTIFICATION_REQUIREMENTS) {
    if (!covered.has(requirement)) {
      throw new Error(
        `Mandatory certification scenario is missing: ${requirement}`,
      )
    }
  }

  for (const scenario of CERTIFICATION_SCENARIOS) {
    if (scenario.evidence.length === 0) {
      throw new Error(
        `Certification scenario has no evidence: ${scenario.area}`,
      )
    }
    for (const reference of scenario.evidence) {
      let source: string
      try {
        source = await readText(reference.path)
      } catch {
        throw new Error(`Certification evidence is missing: ${reference.path}`)
      }
      for (const testName of reference.testNames) {
        if (!source.includes(testName)) {
          throw new Error(
            `Certification test is missing from ${reference.path}: ${testName}`,
          )
        }
        if (!evidenceIsRunnable(source, testName)) {
          throw new Error(
            `Certification evidence is not runnable in ${reference.path}: ${testName}`,
          )
        }
      }
    }
  }
}

function validateFingerprint(value: string, label: string) {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) {
    throw new Error(
      `${label} fingerprint must be a bounded opaque identifier without secret material.`,
    )
  }
}

function validateInput(input: CertificationInput) {
  if (!/^[0-9a-f]{40}$/.test(input.certifiedCommit)) {
    throw new Error('Certified commit must be a 40-character Git commit.')
  }
  if (!input.worktreeClean) {
    throw new Error('Certification requires a clean worktree.')
  }
  if (input.apiVersion !== PAYTO_PAYMENT_API_VERSION) {
    throw new Error(
      `Certification requires API version ${PAYTO_PAYMENT_API_VERSION}.`,
    )
  }
  if (input.environment !== 'sandbox' && input.environment !== 'production') {
    throw new Error('Certification environment must be sandbox or production.')
  }
  validateFingerprint(input.configurationFingerprint, 'configuration')
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.credentialFingerprint)) {
    throw new Error(
      'credential fingerprint must be a SHA-256 base64url value, never a credential.',
    )
  }
  if (input.results.length !== CERTIFICATION_COMMANDS.length) {
    throw new Error('Certification command result set is incomplete.')
  }
  for (const command of CERTIFICATION_COMMANDS) {
    const result = input.results.find(({ id }) => id === command.id)
    if (
      !result ||
      result.displayCommand !== command.displayCommand ||
      result.exitCode !== 0
    ) {
      throw new Error(`Certification command failed: ${command.displayCommand}`)
    }
  }
}

export function certificationFingerprint(input: CertificationInput) {
  validateInput(input)
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        certifiedCommit: input.certifiedCommit,
        evidenceDate: input.evidenceDate,
        environment: input.environment,
        apiVersion: input.apiVersion,
        configurationFingerprint: input.configurationFingerprint,
        credentialFingerprint: input.credentialFingerprint,
        commandSet: CERTIFICATION_COMMANDS.map(({ id, displayCommand }) => ({
          id,
          displayCommand,
        })),
        scenarioSet: CERTIFICATION_SCENARIOS.map(({ area, requirements }) => ({
          area,
          requirements,
        })),
      }),
    )
    .digest('base64url')
}

function scenarioRows() {
  return CERTIFICATION_SCENARIOS.map(
    ({ area, requirements, evidence, deterministicDrill, safetyOutcome }) =>
      `| ${area} | ${requirements.map((requirement) => `\`${requirement}\``).join(', ')} | ${evidence.map(({ path }) => `\`${path}\``).join('; ')} | ${deterministicDrill} | ${safetyOutcome} |`,
  ).join('\n')
}

export function buildCertificationReport(input: CertificationInput): string {
  validateInput(input)
  const fingerprint = certificationFingerprint(input)
  const commandRows = CERTIFICATION_COMMANDS.map(
    ({ id, displayCommand }) =>
      `| ${id} | \`${displayCommand}\` | PASS (exit 0) |`,
  ).join('\n')

  return `# PayTo Payment deterministic certification

| Field | Certified value |
| --- | --- |
| Commit | \`${input.certifiedCommit}\` |
| Evidence date | ${input.evidenceDate} |
| Environment | Zepto ${input.environment} |
| API version | \`${input.apiVersion}\` |
| Configuration fingerprint | \`${input.configurationFingerprint}\` |
| Credential fingerprint | \`${input.credentialFingerprint}\` |
| Certification fingerprint | \`${fingerprint}\` |
| Evidence class | Deterministic automated certification through production code seams; no live provider access |

## Command results

| Gate | Command | Result |
| --- | --- | --- |
${commandRows}

All commands ran from a clean worktree at the exact certified commit. Command output is excluded so credentials, routing details, provider payloads, raw webhook bodies, environment values, and other sensitive material cannot enter this evidence.

## Mandatory scenario evidence

| Area | Mandatory requirement | Automated evidence | Deterministic drill | Safety outcome |
| --- | --- | --- | --- | --- |
${scenarioRows()}

Every named test above was present and runnable before the quality gates ran. A missing, skipped, todo, or quarantined mandatory scenario fails certification and no manifest is emitted.

## Activation decision

This report certifies deterministic behavior for the recorded commit, environment, pinned API version, configuration fingerprint, and credential fingerprint only. Production activation remains denied: certification does not change a runtime gate, grant provider access, supply independent approvals, or replace fresh sanitized live Zepto sandbox evidence.

## Invalidation and rerun triggers

Rerun \`bun run certify:pay-to-payment\` after any material change to code, API version, environment, credentials, Payment configuration, this manifest, or referenced scenario evidence. A changed bound value produces a different certification fingerprint and invalidates the applicable prior evidence. Live sandbox evidence remains separate and subject to its own freshness and approval rules.
`
}
