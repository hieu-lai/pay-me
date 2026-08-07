import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Button } from '#/components/ui/button'
import { useState } from 'react'

import { Form } from './form'

export function AddPayoutMethod() {
  const [open, setOpen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button>Add payout method</Button>} />
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Add payout method</SheetTitle>
          <SheetDescription>Choose bank account or PayID</SheetDescription>
        </SheetHeader>
        <Form onSuccess={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  )
}
