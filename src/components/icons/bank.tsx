import { forwardRef } from 'react'
import { useLucideContext } from 'lucide-react'
import type { LucideProps } from 'lucide-react'

const hasA11yProp = (props: LucideProps) =>
  Object.keys(props).some(
    (prop) => prop.startsWith('aria-') || prop === 'role' || prop === 'title',
  )

const BankIcon = forwardRef<SVGSVGElement, LucideProps>(
  (
    {
      color,
      size,
      strokeWidth,
      absoluteStrokeWidth,
      className = '',
      children,
      ...props
    },
    ref,
  ) => {
    const {
      color: contextColor = 'currentColor',
      size: contextSize = 24,
      strokeWidth: contextStrokeWidth = 2,
      absoluteStrokeWidth: contextAbsoluteStrokeWidth = false,
      className: contextClassName = '',
    } = useLucideContext()
    const resolvedSize = size ?? contextSize
    const resolvedStrokeWidth = strokeWidth ?? contextStrokeWidth
    const calculatedStrokeWidth =
      (absoluteStrokeWidth ?? contextAbsoluteStrokeWidth)
        ? (Number(resolvedStrokeWidth) * 24) / Number(resolvedSize)
        : resolvedStrokeWidth

    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={resolvedSize}
        height={resolvedSize}
        viewBox="0 0 512 512"
        fill={color ?? contextColor}
        strokeWidth={calculatedStrokeWidth}
        className={['lucide', 'lucide-bank', contextClassName, className]
          .filter(Boolean)
          .join(' ')}
        {...(!children && !hasA11yProp(props) && { 'aria-hidden': true })}
        {...props}
      >
        <path d="M488 462.172H24c-13.199 0-24 10.799-24 24 0 13.199 10.801 24 24 24h464c13.199 0 24-10.801 24-24 0-13.201-10.801-24-24-24Zm-32-32c13.199 0 24-10.801 24-24 0-13.201-10.801-24-24-24H56c-13.199 0-24 10.799-24 24 0 13.199 10.801 24 24 24h400Zm41.172-334.188-232-96a23.927 23.927 0 0 0-18.344 0l-232 96A24 24 0 0 0 0 118.172v64c0 13.25 10.75 24 24 24h40v144h48v-144h64v144h48v-144h64v144h48v-144h64v144h48v-144h40c13.25 0 24-10.75 24-24v-64a24 24 0 0 0-14.828-22.188ZM464 158.172H301.062c1.788-5.027 2.938-10.36 2.938-16 0-26.51-21.49-48-48-48s-48 21.49-48 48c0 5.64 1.15 10.973 2.938 16H48v-23.969l208-86.062 208 86.062v23.969Z" />
        {children}
      </svg>
    )
  },
)

BankIcon.displayName = 'BankIcon'

export default BankIcon
