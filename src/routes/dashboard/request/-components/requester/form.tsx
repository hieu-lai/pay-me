import { useMutation } from '@tanstack/react-query'
import { Avatar, AvatarFallback, AvatarImage } from '#/components/ui/avatar'
import { Button } from '#/components/ui/button'
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '#/components/ui/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from '#/components/ui/input-group'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '#/components/ui/item'
import { toast } from '#/components/ui/toast'
import getInitials from '#/lib/get-initials'
import { pluralize } from '#/lib/utils'
import { submitMoneyRequest } from '#/server-fns/money-requests'
import { DollarSignIcon, XIcon } from 'lucide-react'

import type { Id } from '../../../../../../convex/_generated/dataModel'
import {
  dollarsToCents,
  formatDollarAmount,
  normalizeDollarAmount,
} from './amount'
import { MAX_PAYERS } from './schema'
import { SearchPayers } from './search-payers'
import {
  clearPendingSubmissionKey,
  getPendingSubmissionKey,
} from './submission-key'
import { useRequestForm } from './use-request-form'

export function Form() {
  const { mutate } = useMutation({
    mutationKey: ['moneyRequest'],
    mutationFn: submitMoneyRequest,
    onError: (e: Error) => {
      console.log({ e })
      toast.add({
        type: 'error',
        title: 'Something went wrong',
        description: e.message,
      })
    },
    onSuccess: (_result, { data: { submissionKey, payerIds } }) => {
      clearPendingSubmissionKey(window.sessionStorage, submissionKey)
      toast.add({
        type: 'success',
        title: `Money ${pluralize('request', payerIds.length)} sent`,
      })
      form.reset()
    },
  })

  const form = useRequestForm({
    onSubmit: async (values) => {
      const terms = {
        amountCents: dollarsToCents(values.amount),
        description: values.description,
        payerIds: values.payers.map((payer) => payer.id as Id<'users'>),
      }
      const submissionKey = await getPendingSubmissionKey(
        terms,
        window.sessionStorage,
      )

      mutate({
        data: {
          ...terms,
          submissionKey,
        },
      })
    },
  })

  return (
    <form
      id="request-form"
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <FieldGroup>
        <form.Field
          name="amount"
          children={(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Amount</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <DollarSignIcon />
                  </InputGroupAddon>
                  <InputGroupInput
                    id={field.name}
                    name={field.name}
                    value={formatDollarAmount(field.state.value)}
                    onBlur={field.handleBlur}
                    onChange={(e) =>
                      field.handleChange(normalizeDollarAmount(e.target.value))
                    }
                    aria-invalid={isInvalid}
                    placeholder="0.00"
                    inputMode="decimal"
                    className="text-right"
                  />
                </InputGroup>
                {isInvalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            )
          }}
        />
        <form.Field
          name="description"
          children={(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Description</FieldLabel>
                <InputGroup>
                  <InputGroupTextarea
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    aria-invalid={isInvalid}
                    placeholder="Write a description..."
                  />
                  <InputGroupAddon align="block-end">
                    <InputGroupText>{`${field.state.value.length}/140`}</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
                {isInvalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            )
          }}
        />
        <form.Field
          name="payers"
          mode="array"
          children={(field) => {
            const isInvalid =
              field.state.meta.isTouched && !field.state.meta.isValid
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>
                  {`Payers (${field.state.value.length}/${MAX_PAYERS})`}
                </FieldLabel>
                <SearchPayers
                  id={field.name}
                  name={field.name}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onValueChange={(payers) => {
                    if (payers.length <= MAX_PAYERS) {
                      field.handleChange(payers)
                    }
                  }}
                  aria-invalid={isInvalid}
                />
                {field.state.value.map((_, index) => (
                  <form.Field
                    key={index}
                    name={`payers[${index}]`}
                    children={(subField) => {
                      const payer = subField.state.value

                      return (
                        <Item key={payer.id} variant="outline">
                          <ItemMedia>
                            <Avatar>
                              <AvatarImage src={payer.imageUrl} />
                              <AvatarFallback>
                                {getInitials(payer.name)}
                              </AvatarFallback>
                            </Avatar>
                          </ItemMedia>
                          <ItemContent>
                            <ItemTitle>{payer.name}</ItemTitle>
                            {payer.username && (
                              <ItemDescription>
                                @{payer.username}
                              </ItemDescription>
                            )}
                          </ItemContent>
                          <ItemActions>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => field.removeValue(index)}
                            >
                              <XIcon />
                            </Button>
                          </ItemActions>
                        </Item>
                      )
                    }}
                  />
                ))}
                {isInvalid && <FieldError errors={field.state.meta.errors} />}
              </Field>
            )
          }}
        />
      </FieldGroup>
    </form>
  )
}
