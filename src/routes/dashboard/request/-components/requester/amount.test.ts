import { describe, expect, test } from 'vitest'

import {
  dollarsToCents,
  formatDollarAmount,
  normalizeDollarAmount,
} from './amount'

describe('request amount', () => {
  test.each([
    ['', ''],
    ['1', '1'],
    ['1234', '1,234'],
    ['1234.56', '1,234.56'],
    ['1234567.', '1,234,567.'],
  ])('formats %s for display as %s', (value, expected) => {
    expect(formatDollarAmount(value)).toBe(expected)
  })

  test('removes display separators before storing the form value', () => {
    expect(normalizeDollarAmount('1,234.56')).toBe('1234.56')
  })

  test.each([
    ['1', 100],
    ['1.2', 120],
    ['1234.56', 123_456],
  ])('converts %s dollars to %i cents', (value, expected) => {
    expect(dollarsToCents(value)).toBe(expected)
  })
})
