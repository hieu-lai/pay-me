import { useLucideContext } from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import { forwardRef } from 'react'

const hasA11yProp = (props: LucideProps) =>
  Object.keys(props).some(
    (prop) => prop.startsWith('aria-') || prop === 'role' || prop === 'title',
  )

const CircleCheckIcon = forwardRef<SVGSVGElement, LucideProps>(
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
        <path d="M256 16C123.451 16 16 123.451 16 256s107.451 240 240 240 240-107.451 240-240S388.549 16 256 16Zm115.812 195.812-128 128C238.344 345.281 231.156 348 224 348s-14.344-2.719-19.812-8.188l-64-64c-10.907-10.937-10.907-28.687 0-39.624 10.937-10.938 28.687-10.938 39.624 0L224 280.406l108.188-108.218c10.937-10.938 28.687-10.938 39.624 0 10.907 10.937 10.907 28.687 0 39.624Z" />
        {children}
      </svg>
    )
  },
)

CircleCheckIcon.displayName = 'CircleCheckIcon'

export default CircleCheckIcon
