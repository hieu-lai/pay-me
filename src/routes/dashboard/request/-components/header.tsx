import { CircleDollarSignIcon } from 'lucide-react'

export function Header() {
  return (
    <div className="bg-background sticky top-0 z-10 flex h-12 items-center justify-between rounded-t-2xl border-b px-4">
      <div className="flex items-center gap-2">
        <CircleDollarSignIcon />
        <div>Request</div>
      </div>
    </div>
  )
}
