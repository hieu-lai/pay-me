import { describe, expect, test, vi } from 'vitest'

import type { Id } from '../../../../../../convex/_generated/dataModel'
import type { SubmissionKeyStorage } from './submission-key'
import {
  clearPendingSubmissionKey,
  getPendingSubmissionKey,
} from './submission-key'

function memoryStorage(): SubmissionKeyStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

const terms = {
  amountCents: 12_345,
  description: 'Shared dinner',
  payerId: 'payer-id' as Id<'users'>,
}

describe('Money Request pending submission key', () => {
  test('survives a page reload for the same immutable intent', async () => {
    const storage = memoryStorage()
    const createKey = vi
      .fn()
      .mockReturnValueOnce('018f22e2-7c00-7000-8000-000000000001')
      .mockReturnValueOnce('018f22e2-7c00-7000-8000-000000000002')

    const beforeReload = await getPendingSubmissionKey(
      terms,
      storage,
      createKey,
    )
    const afterReload = await getPendingSubmissionKey(terms, storage, createKey)

    expect(afterReload).toBe(beforeReload)
    expect(createKey).toHaveBeenCalledOnce()
  })

  test('allocates a fresh key when the visible intent changes', async () => {
    const storage = memoryStorage()
    const createKey = vi
      .fn()
      .mockReturnValueOnce('018f22e2-7c00-7000-8000-000000000001')
      .mockReturnValueOnce('018f22e2-7c00-7000-8000-000000000002')

    const first = await getPendingSubmissionKey(terms, storage, createKey)
    const changed = await getPendingSubmissionKey(
      { ...terms, amountCents: 12_346 },
      storage,
      createKey,
    )

    expect(changed).not.toBe(first)
  })

  test('does not let an older success clear a newer pending intent', async () => {
    const storage = memoryStorage()
    const createKey = vi
      .fn()
      .mockReturnValueOnce('018f22e2-7c00-7000-8000-000000000001')
      .mockReturnValueOnce('018f22e2-7c00-7000-8000-000000000002')
    const first = await getPendingSubmissionKey(terms, storage, createKey)
    const second = await getPendingSubmissionKey(
      { ...terms, description: 'Changed dinner' },
      storage,
      createKey,
    )

    clearPendingSubmissionKey(storage, first)

    await expect(
      getPendingSubmissionKey(
        { ...terms, description: 'Changed dinner' },
        storage,
        createKey,
      ),
    ).resolves.toBe(second)
  })
})
