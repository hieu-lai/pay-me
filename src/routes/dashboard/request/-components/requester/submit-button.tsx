import { useIsMutating } from '@tanstack/react-query'
import { Button } from '#/components/ui/button'
import { Spinner } from '#/components/ui/spinner'

export function SubmitButton() {
  const isMutating = useIsMutating({
    mutationKey: ['moneyRequest'],
  })
  const isPending = isMutating > 0

  return (
    <Button
      type="submit"
      form="request-form"
      className="w-full"
      disabled={isPending}
    >
      {isPending && <Spinner />}
      Request
    </Button>
  )
}
