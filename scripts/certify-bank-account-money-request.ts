import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CERTIFICATION_COMMANDS,
  buildCertificationReport,
} from './certification/bank-account-money-request'

const defaultOutput = 'docs/certification/bank-account-money-request.md'
const outputArgument = process.argv.indexOf('--output')
const outputPath = resolve(
  outputArgument === -1
    ? defaultOutput
    : (process.argv[outputArgument + 1] ?? ''),
)

if (outputArgument !== -1 && !process.argv[outputArgument + 1]) {
  throw new Error('--output requires a path.')
}

function run(
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

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(repositoryRoot)

const initialStatus = run('git', ['status', '--porcelain'], { quiet: true })
if (initialStatus.exitCode !== 0) throw new Error('Unable to inspect worktree.')
if (initialStatus.stdout !== '') {
  throw new Error('Certification requires a clean worktree.')
}

const commit = run('git', ['rev-parse', 'HEAD'], { quiet: true })
if (commit.exitCode !== 0)
  throw new Error('Unable to resolve the certified commit.')

const results = []
for (const command of CERTIFICATION_COMMANDS) {
  console.log(`\n[certification] ${command.displayCommand}`)
  const result = run(command.executable, command.args)
  results.push({
    id: command.id,
    displayCommand: command.displayCommand,
    exitCode: result.exitCode,
  })
  if (result.exitCode !== 0) {
    throw new Error(`Certification command failed: ${command.displayCommand}`)
  }
}

const report = buildCertificationReport({
  certifiedCommit: commit.stdout,
  evidenceDate: new Date().toISOString().slice(0, 10),
  worktreeClean: true,
  results,
})
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, report, 'utf8')
console.log(`\n[certification] Wrote ${outputPath}`)
