export function formatDollarAmount(value: string) {
  const [dollars, ...fractionParts] = value.split('.')
  const formattedDollars = dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  return fractionParts.length > 0
    ? `${formattedDollars}.${fractionParts.join('.')}`
    : formattedDollars
}

export function normalizeDollarAmount(value: string) {
  return value.replaceAll(',', '')
}

export function dollarsToCents(value: string) {
  const [dollars, cents = ''] = value.split('.')

  return Number(dollars) * 100 + Number(cents.padEnd(2, '0'))
}
