import { describe, expect, test } from 'vitest'

import { getNextLink } from './pagination'

describe('getNextLink', () => {
  test('finds next among multiple RFC Link relations', () => {
    expect(
      getNextLink(
        '<https://api.example.test/items?page=1>; rel="prev", <https://api.example.test/items?page=3>; rel="next last"',
      ),
    ).toBe('https://api.example.test/items?page=3')
  })

  test.each([null, '', '<https://api.example.test/items?page=1>; rel="prev"'])(
    'returns null when no next relation exists',
    (header) => expect(getNextLink(header)).toBeNull(),
  )
})
