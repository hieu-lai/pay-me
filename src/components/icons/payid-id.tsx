import { useLucideContext } from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import { forwardRef } from 'react'

const hasA11yProp = (props: LucideProps) =>
  Object.keys(props).some(
    (prop) => prop.startsWith('aria-') || prop === 'role' || prop === 'title',
  )

const PayIdIdIcon = forwardRef<SVGSVGElement, LucideProps>(
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
        viewBox="0 0 1000 1000"
        fill={color ?? contextColor}
        strokeWidth={calculatedStrokeWidth}
        className={['lucide', 'lucide-bank', contextClassName, className]
          .filter(Boolean)
          .join(' ')}
        {...(!children && !hasA11yProp(props) && { 'aria-hidden': true })}
        {...props}
      >
        <path
          fillRule="evenodd"
          d="M879.36 120.63a197.69 197.69 0 0 1 57.92 139.83v479.09c0 52.43-20.82 102.74-57.92 139.83-37.07 37.08-87.38 57.9-139.83 57.9H260.45a197.79 197.79 0 0 1-139.83-57.9 197.79 197.79 0 0 1-57.9-139.83V260.46c0-52.45 20.82-102.74 57.9-139.83a197.8 197.8 0 0 1 139.83-57.91h479.08c52.45 0 102.76 20.83 139.83 57.91zm-445.85 469h55.84V327.4c48.76-.3 154.26 9.57 191.58 97.49l51.83-21.91a213.914 213.914 0 0 0-66.28-82.69 213.81 213.81 0 0 0-97.84-40.7 365.925 365.925 0 0 0-110.13-6.17l-25 2.16zM267.36 341.15a42.59 42.59 0 0 0 29.81 12.47c8.36 0 16.51-2.48 23.47-7.12a42.195 42.195 0 0 0 15.56-18.97c3.2-7.72 4.05-16.22 2.42-24.42a42.281 42.281 0 0 0-11.58-21.64 42.215 42.215 0 0 0-21.63-11.56c-8.2-1.63-16.7-.8-24.42 2.4a42.28 42.28 0 0 0-18.97 15.57 42.218 42.218 0 0 0-7.13 23.48 42.63 42.63 0 0 0 12.47 29.79zm536.35 209.91-79.6-101.19-80.5 101.19h45.64a163.15 163.15 0 0 1-8.32 30.85c-28.38 66.94-100.57 101.18-213.48 101.18H323.7V427.66h-56.77v310.96h200.52c137.89 0 227.06-45.66 265.31-135.43a231.803 231.803 0 0 0 13.56-52.13z"
        />
        {children}
      </svg>
    )
  },
)

PayIdIdIcon.displayName = 'PayIdIdIcon'

export default PayIdIdIcon
