import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { format } from 'prettier'

import {
  CERTIFICATION_COMMANDS,
  PAYTO_PAYMENT_API_VERSION,
  buildCertificationReport,
  verifyCertificationEvidence,
} from './certification/pay-to-payment'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const defaultOutput = 'docs/certification/pay-to-payment.md'

function argumentValue(name: string) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value.`)
  }
  return value
}

function requiredBinding(argumentName: string, environmentName: string) {
  const value = argumentValue(argumentName) ?? process.env[environmentName]
  if (!value) {
    throw new Error(
      `${argumentName} or ${environmentName} is required for commit-bound certification.`,
    )
  }
  return value
}

function runCommand(
  executable: string,
  args: ReadonlyArray<string>,
  options: { quiet?: boolean } = {},
) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit',
  })
  return {
    exitCode: result.status ?? 1,
    stdout: options.quiet ? result.stdout.trim() : '',
  }
}

function inspectRepository() {
  const status = runCommand('git', ['status', '--porcelain'], { quiet: true })
  const commit = runCommand('git', ['rev-parse', 'HEAD'], { quiet: true })
  if (status.exitCode !== 0 || commit.exitCode !== 0) {
    throw new Error('Unable to inspect the certification worktree and commit.')
  }
  return { clean: status.stdout === '', commit: commit.stdout }
}

process.chdir(repositoryRoot)

const outputPath = resolve(argumentValue('--output') ?? defaultOutput)
const environment = requiredBinding(
  '--environment',
  'PAYTO_PAYMENT_CERTIFICATION_ENVIRONMENT',
)
if (environment !== 'sandbox' && environment !== 'production') {
  throw new Error('Certification environment must be sandbox or production.')
}
const configurationFingerprint = requiredBinding(
  '--configuration-fingerprint',
  'PAYTO_PAYMENT_CONFIGURATION_FINGERPRINT',
)
const credentialFingerprint = requiredBinding(
  '--credential-fingerprint',
  'PAYTO_PAYMENT_CREDENTIAL_FINGERPRINT',
)

await verifyCertificationEvidence((path) => readFile(path, 'utf8'))

const initial = inspectRepository()
if (!initial.clean) {
  throw new Error('Certification requires a clean worktree.')
}

const results = []
for (const command of CERTIFICATION_COMMANDS) {
  console.log(`\n[PayTo Payment certification] ${command.displayCommand}`)
  const result = runCommand(command.executable, command.args)
  results.push({
    id: command.id,
    displayCommand: command.displayCommand,
    exitCode: result.exitCode,
  })
  if (result.exitCode !== 0) {
    throw new Error(`Certification command failed: ${command.displayCommand}`)
  }
}

const final = inspectRepository()
if (!final.clean) {
  throw new Error(
    'Certification gates changed the clean worktree; no manifest emitted.',
  )
}
if (final.commit !== initial.commit) {
  throw new Error('Certified commit changed while certification was running.')
}

const report = await format(
  buildCertificationReport({
    certifiedCommit: initial.commit,
    evidenceDate: new Date().toISOString().slice(0, 10),
    environment,
    apiVersion: PAYTO_PAYMENT_API_VERSION,
    configurationFingerprint,
    credentialFingerprint,
    worktreeClean: final.clean,
    results,
  }),
  { parser: 'markdown' },
)

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, report, 'utf8')
console.log(`\n[PayTo Payment certification] Wrote ${outputPath}`)
