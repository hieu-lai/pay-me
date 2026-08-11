import {
  CANONICAL_UUID_V7_PATTERN,
  fingerprintMoneyRequestTerms,
} from '../../../../../../convex/lib/moneyRequestIngress'
import type { MoneyRequestTerms } from '../../../../../../convex/lib/moneyRequestIngress'
import { v7 as uuid } from 'uuid'

export type SubmissionKeyStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>

type PendingSubmission = {
  fingerprint: string
  submissionKey: string
}

const STORAGE_KEY = 'payme:pending-money-request'
const volatilePendingSubmissions = new WeakMap<
  SubmissionKeyStorage,
  PendingSubmission
>()

function parsePendingSubmission(value: string | null) {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'fingerprint' in parsed &&
      typeof parsed.fingerprint === 'string' &&
      'submissionKey' in parsed &&
      typeof parsed.submissionKey === 'string' &&
      CANONICAL_UUID_V7_PATTERN.test(parsed.submissionKey)
    ) {
      return parsed as PendingSubmission
    }
  } catch {
    return null
  }
  return null
}

function readPendingSubmission(storage: SubmissionKeyStorage) {
  try {
    return (
      parsePendingSubmission(storage.getItem(STORAGE_KEY)) ??
      volatilePendingSubmissions.get(storage) ??
      null
    )
  } catch {
    return volatilePendingSubmissions.get(storage) ?? null
  }
}

function writePendingSubmission(
  storage: SubmissionKeyStorage,
  pending: PendingSubmission,
) {
  volatilePendingSubmissions.set(storage, pending)
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(pending))
  } catch {
    // The in-memory fallback still protects retries in the current page.
  }
}

export async function getPendingSubmissionKey(
  terms: MoneyRequestTerms,
  storage: SubmissionKeyStorage,
  createKey: () => string = () => uuid({ msecs: Date.now() }),
) {
  const fingerprint = await fingerprintMoneyRequestTerms(terms)
  const pending = readPendingSubmission(storage)
  if (pending?.fingerprint === fingerprint) return pending.submissionKey

  const submissionKey = createKey()
  writePendingSubmission(storage, { fingerprint, submissionKey })
  return submissionKey
}

export function clearPendingSubmissionKey(
  storage: SubmissionKeyStorage,
  submissionKey: string,
) {
  const pending = readPendingSubmission(storage)
  if (pending?.submissionKey !== submissionKey) return

  volatilePendingSubmissions.delete(storage)
  try {
    storage.removeItem(STORAGE_KEY)
  } catch {
    // The matching in-memory fallback has already been cleared.
  }
}
