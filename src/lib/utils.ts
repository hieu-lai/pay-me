import { clsx } from 'clsx'
import type { ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export const range = (length: number): Array<number> =>
  Array.from({ length }, (_, i) => i)

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function pluralize(word: string, count: number): string {
  const irregulars: { [key: string]: string } = {
    child: 'children',
    man: 'men',
    woman: 'women',
    person: 'people',
    mouse: 'mice',
    foot: 'feet',
    tooth: 'teeth',
    goose: 'geese',
  }

  if (count === 1) {
    return word
  }

  if (irregulars[word.toLowerCase()]) {
    return irregulars[word.toLowerCase()]
  }

  if (word.match(/[^aeiou]y$/)) {
    return word.replace(/y$/, 'ies')
  }

  if (word.match(/(s|x|ch|sh)$/)) {
    return word + 'es'
  }

  return word + 's'
}
