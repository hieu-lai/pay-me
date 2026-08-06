import { auth } from '@clerk/tanstack-react-start/server'
import { createServerFn } from '@tanstack/react-start'

export const getAuth = createServerFn({ method: 'GET' }).handler(async () => {
  const { userId, getToken } = await auth()

  return {
    userId,
    token: await getToken(),
  }
})
