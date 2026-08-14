import { convexQuery } from '@convex-dev/react-query'
import { useSuspenseQuery } from '@tanstack/react-query'

import { api } from '../../../../../../convex/_generated/api'
import { Form } from './form'

export function ProfileForm() {
  const { data } = useSuspenseQuery(convexQuery(api.users.me))

  return <Form />
}
