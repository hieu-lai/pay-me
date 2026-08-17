import type { Doc } from '../_generated/dataModel'
import { profileImageUrl } from './profileImageStorage'

const displayNameSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
})

export function normalizeDisplayName(value: string): string {
  const nfcValue = value.normalize('NFC')
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(nfcValue)) {
    throw new Error('Clerk provided an invalid Display Name.')
  }
  const normalized = nfcValue.trim().replace(/\p{Zs}+/gu, ' ')

  if (
    normalized.length === 0 ||
    [...displayNameSegmenter.segment(normalized)].length > 80
  ) {
    throw new Error('Clerk provided an invalid Display Name.')
  }

  return normalized
}

export function presentUser(user: Doc<'users'>) {
  const imageUrl = profileImageUrl(user.profileImageSource)
  return {
    id: user._id,
    name: user.displayName,
    ...(user.bio === undefined ? {} : { bio: user.bio }),
    ...(imageUrl === undefined ? {} : { imageUrl }),
  }
}
