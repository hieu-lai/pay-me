import { Link } from '@tanstack/react-router'
import { Button, buttonVariants } from '#/components/ui/button'
import { Skeleton } from '#/components/ui/skeleton'
import { AuthLoading, Authenticated, Unauthenticated } from 'convex/react'

export function Header() {
  return (
    <div className="bg-background/70 sticky top-0 flex h-14 w-full items-center justify-between px-2 backdrop-blur-md">
      <h1 className="text-lg font-bold">PayMe</h1>
      <AuthLoading>
        <Skeleton className="size-8 rounded-full" />
      </AuthLoading>
      <Authenticated>
        <Button>Join up</Button>
      </Authenticated>
      <Unauthenticated>
        <div className="flex items-center gap-2">
          <Link
            to="/sign-in/$"
            className={buttonVariants({ variant: 'secondary' })}
          >
            Log in
          </Link>
          <Link
            to="/sign-up/$"
            className={buttonVariants({ variant: 'default' })}
          >
            Join up
          </Link>
        </div>
      </Unauthenticated>
    </div>
  )
}
