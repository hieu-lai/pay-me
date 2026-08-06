import { SignUp } from '@clerk/tanstack-react-start'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_auth-layout/sign-up/$')({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <SignUp
      signInUrl="/sign-in"
      routing="path"
      path="/sign-up"
      // fallbackRedirectUrl="/"
    />
  )
}
