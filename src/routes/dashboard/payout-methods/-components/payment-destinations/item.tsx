import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ItemActions,
  ItemContent,
  ItemFooter,
  ItemMedia,
  ItemTitle,
  Item as ShadcnItem,
} from '@/components/ui/item'
import { useConvexMutation } from '@convex-dev/react-query'
import { useMutation } from '@tanstack/react-query'
import BankIcon from '#/components/icons/bank'
import PayIdIdIcon from '#/components/icons/payid-id'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '#/components/ui/alert-dialog'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Spinner } from '#/components/ui/spinner'
import { toast } from '#/components/ui/toast'
import type { PaginatedQueryItem } from 'convex/react'
import type { ConvexError } from 'convex/values'
import { AwardIcon, EllipsisVerticalIcon, Trash2Icon } from 'lucide-react'
import { useState } from 'react'

import { api } from '../../../../../../convex/_generated/api'

type Props = {} & PaginatedQueryItem<typeof api.paymentDestinations.list>

export function Item({ kind, label, maskedDisplay, isDefault, id }: Props) {
  const [open, setOpen] = useState(false)

  const setDefaultMutation = useConvexMutation(
    api.paymentDestinations.setDefault,
  )
  const removeMutation = useConvexMutation(api.paymentDestinations.remove)

  const { mutate: setDefault } = useMutation({
    mutationFn: setDefaultMutation,
    onError: (e: ConvexError<{ message: string }>) => {
      toast.add({
        type: 'error',
        title: 'Something went wrong',
        description: e.data.message,
      })
    },
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Updated default payout method',
      })
      setOpen(false)
    },
  })

  const { mutate: remove, isPending } = useMutation({
    mutationFn: removeMutation,
    onError: (e: ConvexError<{ message: string }>) => {
      toast.add({
        type: 'error',
        title: 'Something went wrong',
        description: e.data.message,
      })
    },
    onSuccess: () => {
      toast.add({
        type: 'success',
        title: 'Removed payout method',
      })
      setOpen(false)
    },
  })

  return (
    <>
      <ShadcnItem variant="outline">
        <ItemMedia variant="icon">
          {kind === 'bankAccount' ? <BankIcon /> : <PayIdIdIcon />}
        </ItemMedia>
        <ItemContent>
          <ItemTitle>
            {label || (kind === 'bankAccount' ? 'Account' : 'PayID')}
            {isDefault && <Badge>Default</Badge>}
          </ItemTitle>
        </ItemContent>
        <ItemActions>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm">
                  <EllipsisVerticalIcon />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => setDefault({ destinationId: id })}
              >
                <AwardIcon />
                Make default
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setOpen((prev) => !prev)}
              >
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ItemActions>
        <ItemFooter>
          {kind === 'payId' ? 'PayID: ' : ''}
          {maskedDisplay}
        </ItemFooter>
      </ShadcnItem>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogMedia className="bg-destructive/10 text-destructive dark:bg-destructive/20 dark:text-destructive">
              <Trash2Icon />
            </AlertDialogMedia>
            <AlertDialogTitle>Delete payout method</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this payout method. Are you sure you
              want to continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel variant="outline" disabled={isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              render={
                <Button
                  disabled={isPending}
                  onClick={() => remove({ destinationId: id })}
                >
                  {isPending && <Spinner />}
                  Delete
                </Button>
              }
            ></AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
