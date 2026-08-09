export function userSearchText(profile: {
  name: string
  username?: string
}): string {
  return [profile.name, profile.username]
    .filter((value): value is string => value !== undefined)
    .join(' ')
}
