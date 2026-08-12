export type CertificationCommandId =
  | 'formatting'
  | 'linting'
  | 'type-checking'
  | 'complete-test-suite'
  | 'production-build'

export type CertificationRequirement =
  | 'valid-and-adversarial-ingress'
  | 'atomic-allocation'
  | 'idempotency'
  | 'mixed-group-outcomes'
  | 'ambiguous-creation'
  | 'retry-budgets'
  | 'leases'
  | 'role-authorization'
  | 'information-flow'
  | 'webhook-authenticity-and-deduplication'
  | 'reconciliation'
  | 'targeted-recovery'
  | 'network-ambiguity'
  | 'action-crashes'
  | 'duplicate-delivery'
  | 'forged-webhooks'
  | 'unknown-provider-states'
  | 'provider-rejection'
  | 'missed-webhook-repair'
  | 'bounded-rate-limiting'
  | 'authentication'
  | 'csrf'
  | 'attestation'
  | 'trusted-ip-handling'
  | 'sibling-authorization'
  | 'destination-races'
  | 'redaction'
  | 'internal-only-operations'
  | 'production-denial'

export const CERTIFICATION_COMMANDS: ReadonlyArray<{
  id: CertificationCommandId
  displayCommand: string
  executable: string
  args: ReadonlyArray<string>
}> = [
  {
    id: 'formatting',
    displayCommand: 'bun run check',
    executable: 'bun',
    args: ['run', 'check'],
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
]

type CertificationScenario = {
  area: string
  requirements: ReadonlyArray<CertificationRequirement>
  evidence: string
  simulation: string
  recoveryOutcome: string
  telemetryAssertion: string
}

export const CERTIFICATION_SCENARIOS: ReadonlyArray<CertificationScenario> = [
  {
    area: 'Trusted ingress',
    requirements: [
      'valid-and-adversarial-ingress',
      'authentication',
      'csrf',
      'attestation',
      'trusted-ip-handling',
    ],
    evidence:
      '`src/server-fns/money-requests.test.ts`; `convex/moneyRequests.test.ts`',
    simulation:
      'Authenticated and unauthenticated identities, POST-only server ingress, fixed clock, canonical and rejected ingress values, tampered and expired attestations.',
    recoveryOutcome:
      'Rejected ingress creates no durable request; a valid retry remains safe.',
    telemetryAssertion:
      'Public errors are classified without logging trusted ingress or attestation material.',
  },
  {
    area: 'Atomic allocation and destination trust',
    requirements: ['atomic-allocation', 'destination-races'],
    evidence: '`convex/moneyRequests.test.ts`',
    simulation:
      'One-to-five Payer fixtures, missing/default-changed destinations, later-Payer race, and injected UID allocation failure.',
    recoveryOutcome:
      'The entire local allocation commits once or rolls back; no partial root or work remains.',
    telemetryAssertion:
      'Durable normalized evidence records accepted work without plaintext routing values.',
  },
  {
    area: 'Durable idempotency',
    requirements: ['idempotency'],
    evidence:
      '`convex/moneyRequests.test.ts`; `src/routes/dashboard/request/-components/requester/submission-key.test.ts`',
    simulation:
      'Response loss, page reload, concurrent replay, reordered Payer set, changed intent, and fresh submission key.',
    recoveryOutcome:
      'Same key and fingerprint converge on one intent; conflicts fail safely; a fresh key creates a new intent.',
    telemetryAssertion:
      'Replay is visible through bounded normalized local evidence, with no duplicated provider work.',
  },
  {
    area: 'Independent group outcomes',
    requirements: ['mixed-group-outcomes'],
    evidence: '`convex/moneyRequests.test.ts`',
    simulation:
      'Five deterministic Payers covering success, rejection, ambiguity, delay, backpressure, and recovery.',
    recoveryOutcome:
      'Successful siblings remain durable and only the targeted held agreement is reopened.',
    telemetryAssertion:
      'Each agreement keeps independent creation, lifecycle, tracking, failure, and evidence state.',
  },
  {
    area: 'Creation ambiguity and bounded work',
    requirements: [
      'ambiguous-creation',
      'network-ambiguity',
      'action-crashes',
      'retry-budgets',
      'leases',
      'provider-rejection',
      'bounded-rate-limiting',
    ],
    evidence:
      '`convex/payToAgreementCreationState.test.ts`; `convex/moneyRequests.test.ts`; `convex/lib/zepto/client.test.ts`',
    simulation:
      'Invalid/ambiguous responses, transport failures, expired workers, duplicate/stale workers, provider rejection, Retry-After, and retry exhaustion.',
    recoveryOutcome:
      'Same-UID GET precedes a bounded second POST cycle; work reaches created, failed, or manual hold without an unbounded retry.',
    telemetryAssertion:
      'Attempt counts, safe failure classes, lease expiry, and review outcomes are normalized as durable evidence.',
  },
  {
    area: 'Role authorization and information flow',
    requirements: [
      'role-authorization',
      'sibling-authorization',
      'information-flow',
      'redaction',
    ],
    evidence: '`convex/moneyRequests.test.ts`',
    simulation:
      'Requester, assigned Payer, sibling Payer, unrelated User, and nonexistent identifiers across detail and paginated histories.',
    recoveryOutcome:
      'Unauthorized and missing detail are indistinguishable; permitted projections remain usable.',
    telemetryAssertion:
      'Public results and captured logs exclude routing, provider, attestation, trusted-ingress, sibling, and internal fields.',
  },
  {
    area: 'Webhook trust and deduplication',
    requirements: [
      'webhook-authenticity-and-deduplication',
      'duplicate-delivery',
      'forged-webhooks',
    ],
    evidence:
      '`convex/lib/zepto/webhook.test.ts`; `convex/zeptoWebhook.test.ts`',
    simulation:
      'Exact raw bytes, forged signatures, malformed bodies, multi-item atomic delivery, repeated delivery IDs, and repeated event IDs.',
    recoveryOutcome:
      'Unverified input changes nothing; verified duplicates are no-ops; committed signals schedule confirmation.',
    telemetryAssertion:
      'Only normalized event identity, lifecycle meaning, ordering, and deduplication outcome are retained.',
  },
  {
    area: 'Lifecycle reconciliation',
    requirements: [
      'reconciliation',
      'unknown-provider-states',
      'missed-webhook-repair',
    ],
    evidence:
      '`convex/payToAgreementReconciliationState.test.ts`; `convex/payToAgreementReconciliation.test.ts`; `convex/lib/zepto/reconciliation.test.ts`',
    simulation:
      'Missed webhook, provisional state, unknown GET state, contradiction, six failures, 24-hour outage, duplicate lease, and expired lease.',
    recoveryOutcome:
      'GET confirms or safely challenges truth, missed signals repair, terminal state stays closed, and daily repair continues after review.',
    telemetryAssertion:
      'Evidence and warning fields contain safe categories, counts, times, and internal identifiers rather than provider bodies.',
  },
  {
    area: 'Targeted recovery and private operations',
    requirements: ['targeted-recovery', 'internal-only-operations'],
    evidence: '`convex/moneyRequests.test.ts`; Convex generated API typecheck',
    simulation:
      'Authenticated operator identity input, empty identity/reason, established absence, ambiguous hold, terminal agreement, and sibling state.',
    recoveryOutcome:
      'Only one eligible agreement reopens through an internal mutation and appends accountable evidence without replacing its UID.',
    telemetryAssertion:
      'Operator action evidence is normalized and scoped to the targeted agreement.',
  },
  {
    area: 'Sandbox-only production denial',
    requirements: ['production-denial'],
    evidence:
      '`convex/lib/zepto/env.test.ts`; `convex/lib/zepto/client.test.ts`; `convex/lib/payIdCapability.test.ts`',
    simulation:
      'Production origin, production credential path, sandbox credentials under production configuration, simulation routes/body fields, and uncertified PayID capability.',
    recoveryOutcome:
      'The operation fails before provider fetch; certification never changes runtime configuration.',
    telemetryAssertion:
      'Failures use redaction-safe configuration or sandbox-only classes without credentials.',
  },
]

type CertificationResult = {
  id: CertificationCommandId
  displayCommand: string
  exitCode: number
}

type CertificationInput = {
  certifiedCommit: string
  evidenceDate: string
  worktreeClean: boolean
  results: ReadonlyArray<CertificationResult>
}

function validateInput(input: CertificationInput) {
  if (!/^[0-9a-f]{40}$/.test(input.certifiedCommit)) {
    throw new Error('Certified commit must be a 40-character Git commit.')
  }
  if (!input.worktreeClean) {
    throw new Error('Certification requires a clean worktree.')
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

function scenarioRows() {
  return CERTIFICATION_SCENARIOS.map(
    ({ area, evidence, simulation, recoveryOutcome, telemetryAssertion }) =>
      `| ${area} | ${evidence} | ${simulation} | ${recoveryOutcome} | ${telemetryAssertion} |`,
  ).join('\n')
}

export function buildCertificationReport(input: CertificationInput): string {
  validateInput(input)
  const commandRows = CERTIFICATION_COMMANDS.map(
    ({ id, displayCommand }) =>
      `| ${id} | \`${displayCommand}\` | PASS (exit 0) |`,
  ).join('\n')

  return `# Bank Account Money Request automated certification

| Field | Certified value |
| --- | --- |
| Commit | \`${input.certifiedCommit}\` |
| Evidence date | ${input.evidenceDate} |
| Capability scope | Bank Account Money Requests only; PayID remains independently gated |
| Environment | Zepto sandbox (simulated HTTP boundary) |
| API version | \`20260101\` |
| Evidence class | Deterministic automated certification; no live provider or privileged access |

## Command results

| Gate | Command | Result |
| --- | --- | --- |
${commandRows}

All commands ran from a clean worktree at the certified commit. Command output is intentionally excluded so logs, environment values, credentials, and provider payloads cannot enter this report.

## Covered scenarios and drills

| Area | Automated evidence | Deterministic fixture or simulation | Recovery outcome | Telemetry assertion |
| --- | --- | --- | --- | --- |
${scenarioRows()}

The complete suite covers valid and adversarial ingress, atomic allocation, idempotency, mixed outcomes, ambiguity, bounded retry and leases, authorization and information flow, webhook trust and deduplication, reconciliation, and targeted recovery. Its deterministic drills include network ambiguity, action crashes and expired work, duplicate delivery, forged webhooks, unknown provider states, provider rejection, missed-webhook repair, and bounded Retry-After handling.

## Capability and activation decision

This evidence certifies automated behavior for the Bank Account capability in a simulated sandbox environment. It does not certify live Zepto behavior, PayID, production eligibility, or production activation. Production activation remains denied: sandbox-only workers require sandbox configuration, reject production credential paths, and reject production-only simulation paths before any provider request, regardless of this result.

## Known automated-coverage gaps

- TanStack Start supplies the CSRF boundary for the POST-only server function; the suite certifies the POST-only application configuration but does not duplicate the framework's own origin-validation tests.
- Live Zepto sandbox behavior, webhook delivery by Zepto, real trusted-edge forwarding, external quotas, and provider-enabled scopes require separate sanitized live evidence.
- Human security review, legal/compliance approval, written Zepto eligibility, operational dashboards, alert routing, owners, and production configuration are deliberate activation gates and are not automated by this report.
- PayID remains independently disabled unless its commit-bound live certification capability is complete.

## Rerun triggers

Rerun \`bun run certify:bank-account-money-request\` for every candidate release and after material changes to authentication, authorization, storage, orchestration, provider payload or API version, credentials, webhook configuration, trusted ingress, deployment runtime, production guards, this manifest, or any referenced test. Fresh live evidence remains subject to the 30-day activation rule even when this automated report still passes.
`
}
