import { describe, expect, test } from 'vitest'

import { formSchema } from './schema'

const validProfile = {
  name: 'Ada Lovelace',
  bio: 'Pioneer of computing.',
  image: null,
}

describe('profile schema', () => {
  test('accepts a profile without an image', () => {
    const result = formSchema.safeParse(validProfile)

    expect(result.success).toBe(true)
  })

  test('accepts an existing image string', () => {
    const result = formSchema.safeParse({
      ...validProfile,
      image: 'https://example.com/avatar.png',
    })

    expect(result.success).toBe(true)
  })

  test('accepts a new image with metadata', () => {
    const result = formSchema.safeParse({
      ...validProfile,
      image: {
        file: new File(['avatar'], 'avatar.png', { type: 'image/png' }),
        metadata: {
          name: 'avatar.png',
          type: 'image/png',
          size: 6,
          preview: 'blob:avatar',
        },
      },
    })

    expect(result.success).toBe(true)
  })

  test('rejects a blank or overlong name', () => {
    expect(formSchema.safeParse({ ...validProfile, name: '   ' }).success).toBe(
      false,
    )
    expect(
      formSchema.safeParse({ ...validProfile, name: 'a'.repeat(81) }).success,
    ).toBe(false)
  })

  test('accepts an empty bio', () => {
    expect(formSchema.safeParse({ ...validProfile, bio: '' }).success).toBe(
      true,
    )
  })

  test('rejects an overlong bio', () => {
    expect(
      formSchema.safeParse({
        ...validProfile,
        bio: 'a'.repeat(161),
      }).success,
    ).toBe(false)
  })

  test('rejects invalid image metadata', () => {
    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' })

    expect(
      formSchema.safeParse({
        ...validProfile,
        image: {
          file,
          metadata: { name: 'avatar.gif', type: 'image/gif', size: 6 },
        },
      }).success,
    ).toBe(false)

    expect(
      formSchema.safeParse({
        ...validProfile,
        image: {
          file,
          metadata: { name: '', type: 'image/png', size: 6 },
        },
      }).success,
    ).toBe(false)

    expect(
      formSchema.safeParse({
        ...validProfile,
        image: {
          file,
          metadata: {
            name: 'avatar.png',
            type: 'image/png',
            size: 5 * 1024 * 1024 + 1,
          },
        },
      }).success,
    ).toBe(false)
  })

  test('rejects unsupported image values', () => {
    expect(formSchema.safeParse({ ...validProfile, image: 123 }).success).toBe(
      false,
    )
    expect(
      formSchema.safeParse({ ...validProfile, image: undefined }).success,
    ).toBe(false)
  })
})
