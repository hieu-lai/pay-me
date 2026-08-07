import { useTheme } from '#/components/theme-provider'
import { DropdownMenuItem } from '#/components/ui/dropdown-menu'
import { Moon, Sun } from 'lucide-react'

export function ModeButton() {
  const { setTheme, theme } = useTheme()

  return (
    <DropdownMenuItem
      closeOnClick={false}
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      <Sun className="h-[1.2rem] w-[1.2rem] scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
      <Moon className="absolute h-[1.2rem] w-[1.2rem] scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />

      {theme === 'dark' ? 'Dark mode' : 'Light mode'}
    </DropdownMenuItem>
  )
}
