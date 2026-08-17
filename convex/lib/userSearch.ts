export function userSearchText(profile: {
  displayName: string
  username?: string
}): string {
  return [profile.displayName, profile.username]
    .filter((value): value is string => value !== undefined)
    .join(' ')
}
