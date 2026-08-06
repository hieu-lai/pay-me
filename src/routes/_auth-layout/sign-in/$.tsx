import { SignIn } from '@clerk/tanstack-react-start'
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_auth-layout/sign-in/$')({
  component: RouteComponent,
})

function RouteComponent() {
  return (
    <SignIn
      signUpUrl="/sign-up"
      routing="path"
      path="/sign-in"
      fallbackRedirectUrl="/"
    />
  )
}
