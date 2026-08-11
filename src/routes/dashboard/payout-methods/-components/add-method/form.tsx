import { useConvexAction } from '@convex-dev/react-query'
import { useMutation } from '@tanstack/react-query'
import BankIcon from '#/components/icons/bank'
import CircleCheckIcon from '#/components/icons/circle-check'
import PayIdIdIcon from '#/components/icons/payid-id'
import { Button } from '#/components/ui/button'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '#/components/ui/input-group'
import { RadioGroup, RadioGroupItem } from '#/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { SheetClose, SheetFooter } from '#/components/ui/sheet'
import { Spinner } from '#/components/ui/spinner'
import { toast } from '#/components/ui/toast'
import type { ConvexError } from 'convex/values'
import {
  Building2,
  ChevronDownIcon,
  IdCardIcon,
  MailIcon,
  SmartphoneIcon,
} from 'lucide-react'

import { api } from '../../../../../../convex/_generated/api'
import { usePayoutMethodForm } from './use-payout-method-form'

const methods = [
  {
    id: 'payid',
    title: 'PayID',
    description: 'Payouts using your PayID.',
    icon: <PayIdIdIcon className="size-5" />,
  },
  {
    id: 'bankAccount',
    title: 'Bank account',
    description: 'Payouts via BSB and account number.',
    icon: <BankIcon className="size-5" />,
  },
] as const

const payIdTypes = [
  {
    label: 'Email',
    value: 'alias_email',
    placeholder: 'name@example.com',
    icon: <MailIcon />,
  },
  {
    label: 'Mobile',
    value: 'alias_phone',
    placeholder: '04xx xxx xxx',
    icon: <SmartphoneIcon />,
  },
  {
    label: 'ABN',
    value: 'alias_abn',
    placeholder: 'XX XXX XXX XXX',
    icon: <IdCardIcon />,
  },
  {
    label: 'Org. ID',
    value: 'alias_organisation_identifier',
    placeholder: 'Enter organisation ID',
    icon: <Building2 />,
  },
] as const

type PayIdAliasType = (typeof payIdTypes)[number]['value']

function normalizeAliasValue(type: PayIdAliasType, value: string): string {
  switch (type) {
    case 'alias_phone':
      return value
        .replace(/[\s()-]/g, '')
        .replace(/^0/, '+61')
        .replace(/^\+61/, '+61-')
    case 'alias_email':
      return value.normalize('NFC').trim().toLowerCase()
    case 'alias_abn':
      return value.replace(/\s/g, '')
    case 'alias_organisation_identifier':
      return value.normalize('NFC').trim()
  }
}

export function Form({ onSuccess }: { onSuccess: () => void }) {
  const addPaymentDestination = useConvexAction(api.paymentDestinations.create)

  const { mutate, isPending } = useMutation({
    mutationFn: addPaymentDestination,
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
        title: 'Payment method added',
      })
      onSuccess()
    },
  })

  const form = usePayoutMethodForm({
    onSubmit: (values) =>
      mutate({
        label: values.label,
        destination:
          values.method === 'bankAccount'
            ? {
                type: 'bban',
                value: `${values.bsb.replace(/[\s-]/g, '')}-${values.accountNumber.normalize('NFC').trim()}`,
              }
            : {
                type: values.payIdType,
                value: normalizeAliasValue(values.payIdType, values.value),
              },
      }),
  })

  return (
    <>
      <form
        id="add-payout-method-form"
        onSubmit={(e) => {
          e.preventDefault()
          form.handleSubmit()
        }}
        className="h-full overflow-auto px-4"
      >
        <FieldGroup>
          <form.Field
            name="label"
            children={(field) => {
              const isInvalid =
                field.state.meta.isTouched && !field.state.meta.isValid
              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Label</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    aria-invalid={isInvalid}
                    placeholder="Main account"
                    autoComplete="off"
                  />
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              )
            }}
          />
          <form.Field
            name="method"
            children={(field) => {
              const isInvalid =
                field.state.meta.isTouched && !field.state.meta.isValid
              return (
                <FieldSet>
                  <FieldLegend className="text-sm!">Method</FieldLegend>
                  <RadioGroup
                    name={field.name}
                    value={field.state.value}
                    onValueChange={field.handleChange}
                  >
                    {methods.map((method) => (
                      <FieldLabel
                        key={method.id}
                        htmlFor={`form-tanstack-radiogroup-${method.id}`}
                      >
                        <Field
                          orientation="horizontal"
                          data-invalid={isInvalid}
                        >
                          {method.icon}
                          <FieldContent>
                            <FieldTitle>{method.title}</FieldTitle>
                            <FieldDescription>
                              {method.description}
                            </FieldDescription>
                          </FieldContent>
                          <RadioGroupItem
                            value={method.id}
                            id={`form-tanstack-radiogroup-${method.id}`}
                            aria-invalid={isInvalid}
                          />
                        </Field>
                      </FieldLabel>
                    ))}
                  </RadioGroup>
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </FieldSet>
              )
            }}
          />
          <form.Subscribe selector={(state) => state.values.method}>
            {(method) =>
              method === 'bankAccount' ? (
                <FieldGroup>
                  <form.Field
                    name="bsb"
                    children={(field) => {
                      const isInvalid =
                        field.state.meta.isTouched && !field.state.meta.isValid
                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>BSB</FieldLabel>
                          <Input
                            id={field.name}
                            name={field.name}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                            aria-invalid={isInvalid}
                            placeholder="324453"
                            autoComplete="off"
                          />
                          {isInvalid && (
                            <FieldError errors={field.state.meta.errors} />
                          )}
                        </Field>
                      )
                    }}
                  />
                  <form.Field
                    name="accountNumber"
                    children={(field) => {
                      const isInvalid =
                        field.state.meta.isTouched && !field.state.meta.isValid
                      return (
                        <Field data-invalid={isInvalid}>
                          <FieldLabel htmlFor={field.name}>
                            Account number
                          </FieldLabel>
                          <Input
                            id={field.name}
                            name={field.name}
                            value={field.state.value}
                            onBlur={field.handleBlur}
                            onChange={(e) => field.handleChange(e.target.value)}
                            aria-invalid={isInvalid}
                            placeholder="311322548"
                            autoComplete="off"
                          />
                          {isInvalid && (
                            <FieldError errors={field.state.meta.errors} />
                          )}
                        </Field>
                      )
                    }}
                  />
                </FieldGroup>
              ) : (
                <form.Field
                  name="payIdType"
                  children={(payIdTypeField) => (
                    <form.Field
                      name="value"
                      children={(valueField) => {
                        const isInvalid =
                          valueField.state.meta.isTouched &&
                          !valueField.state.meta.isValid
                        const selectedType = payIdTypes.find(
                          (type) => type.value === payIdTypeField.state.value,
                        )

                        const { isDirty, isValid, isValidating } =
                          valueField.state.meta

                        const showValid =
                          isDirty &&
                          isValid &&
                          !isValidating &&
                          !!valueField.state.value?.length

                        return (
                          <Field data-invalid={isInvalid}>
                            <FieldLabel htmlFor={valueField.name}>
                              PayID
                            </FieldLabel>
                            <InputGroup>
                              <Select
                                items={payIdTypes}
                                value={payIdTypeField.state.value}
                                onValueChange={(value) => {
                                  if (value === null) return

                                  payIdTypeField.handleChange(value)
                                  valueField.handleChange('')
                                }}
                              >
                                <SelectTrigger
                                  className="w-fit rounded-r-none border-0 border-r"
                                  nativeButton={false}
                                  render={
                                    <InputGroupAddon>
                                      <SelectValue>
                                        {(value) =>
                                          payIdTypes.find(
                                            (type) => type.value === value,
                                          )?.icon
                                        }
                                      </SelectValue>
                                      <ChevronDownIcon className="size-3.5 opacity-60" />
                                    </InputGroupAddon>
                                  }
                                />
                                <SelectContent>
                                  <SelectGroup>
                                    {payIdTypes.map((item) => (
                                      <SelectItem
                                        key={item.value}
                                        value={item.value}
                                      >
                                        {item.icon}
                                        {item.label}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                              <InputGroupInput
                                id={valueField.name}
                                name={valueField.name}
                                value={valueField.state.value ?? ''}
                                onBlur={valueField.handleBlur}
                                onChange={(e) =>
                                  valueField.handleChange(e.target.value)
                                }
                                aria-invalid={isInvalid}
                                placeholder={selectedType?.placeholder}
                                autoComplete="off"
                              />
                            </InputGroup>
                            {showValid && (
                              <div className="flex items-center gap-1 text-xs font-semibold">
                                <CircleCheckIcon className="size-3.5 text-green-500" />
                                Valid PayID
                              </div>
                            )}

                            {isInvalid && (
                              <FieldError
                                errors={valueField.state.meta.errors}
                              />
                            )}
                          </Field>
                        )
                      }}
                    />
                  )}
                />
              )
            }
          </form.Subscribe>
        </FieldGroup>
      </form>
      <SheetFooter className="flex-row">
        <SheetClose
          render={
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              disabled={isPending}
            >
              Close
            </Button>
          }
        />
        <Button
          type="submit"
          form="add-payout-method-form"
          className="flex-1"
          disabled={isPending}
        >
          {isPending && <Spinner />}
          Add
        </Button>
      </SheetFooter>
    </>
  )
}
