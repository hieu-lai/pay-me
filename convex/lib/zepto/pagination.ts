const linkPattern = /<([^>]*)>\s*;\s*rel=(?:"([^"]*)"|([^,;\s]*))/g

/** Return the URL whose RFC Link relation contains `next`. */
export function getNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null

  for (const match of linkHeader.matchAll(linkPattern)) {
    const relations = (match.at(2) ?? match.at(3) ?? '').split(/\s+/)
    if (relations.includes('next')) return match.at(1) ?? null
  }

  return null
}
