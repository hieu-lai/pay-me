import { useForm } from '@tanstack/react-form'

import { defaultValues, formSchema } from './schema'
import type { FormDefaultValues, FormSubmitValues, FormValues } from './schema'

type FormSubmit = (value: FormSubmitValues) => void | Promise<void>

type FormOptions = {
  defaultValues?: FormDefaultValues
  onSubmit?: FormSubmit
}

export function getFormOptions({
  defaultValues: newDefaultValues,
  onSubmit,
}: FormOptions = {}) {
  return {
    defaultValues: {
      ...defaultValues,
      ...newDefaultValues,
    },
    validators: {
      onSubmit: formSchema,
    },
    onSubmit: ({ value }: { value: FormValues }) =>
      onSubmit?.(formSchema.parse(value)),
  }
}

export function useRequestForm({
  defaultValues: newDefaultValues,
  onSubmit,
}: FormOptions = {}) {
  return useForm({
    ...getFormOptions({
      defaultValues: newDefaultValues,
      onSubmit,
    }),
  })
}

export type UsePromptForm = ReturnType<typeof useRequestForm>
