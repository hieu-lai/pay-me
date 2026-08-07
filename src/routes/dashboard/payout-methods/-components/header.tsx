import { PiggyBankIcon } from 'lucide-react'

import { AddPayoutMethod } from './add-method'

export function Header() {
  return (
    <div className="bg-background sticky top-0 z-10 flex h-12 items-center justify-between rounded-t-2xl border-b px-4">
      <div className="flex items-center gap-2">
        <PiggyBankIcon />
        <div>Payout methods</div>
      </div>
      <AddPayoutMethod />
    </div>
  )
}
