import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '#/components/ui/field'
import { Input } from '#/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  InputGroupTextarea,
} from '#/components/ui/input-group'
import { cn } from '#/lib/utils'
import { Edit2Icon, ImageIcon, Trash2Icon, UploadIcon } from 'lucide-react'
import { useDropzone } from 'react-dropzone'

import { MAX_IMAGE_SIZE } from './schema'
import { useProfileForm } from './use-profile-form'

export function Form() {
  const form = useProfileForm({ onSubmit: (values) => console.log({ values }) })

  const { getRootProps, getInputProps, open } = useDropzone({
    maxFiles: 1,
    maxSize: MAX_IMAGE_SIZE,
    accept: { 'image/png': [], 'image/jpeg': [], 'image/webp': [] },
    onDrop: (acceptedFiles: Array<File>) => {
      const acceptedFile = acceptedFiles[0]

      const acceptedFileType = acceptedFile.type
      if (
        acceptedFileType !== 'image/png' &&
        acceptedFileType !== 'image/jpeg' &&
        acceptedFileType !== 'image/webp'
      ) {
        return
      }

      const preview = URL.createObjectURL(acceptedFile)
      form.setFieldValue('image', {
        file: acceptedFile,
        metadata: {
          name: acceptedFile.name,
          size: acceptedFile.size,
          type: acceptedFileType,
          preview,
        },
      })
    },
  })

  return (
    <>
      <form
        id="profile-form"
        onSubmit={(e) => {
          e.preventDefault()
          form.handleSubmit()
        }}
      >
        <FieldGroup>
          <form.Field
            name="image"
            children={(field) => {
              const isInvalid =
                field.state.meta.isTouched && !field.state.meta.isValid
              const image =
                (typeof field.state.value === 'object' &&
                  field.state.value?.metadata.preview) ||
                (typeof field.state.value === 'string' && field.state.value)

              return (
                <Field
                  data-invalid={isInvalid}
                  className="relative w-fit rounded-full"
                >
                  <div
                    {...getRootProps()}
                    aria-invalid={isInvalid}
                    className={cn(
                      'aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 relative flex size-56! items-center justify-center overflow-hidden rounded-full border-2 border-dashed',
                      typeof field.state.value === 'object' &&
                        field.state.value?.metadata.preview &&
                        'border-0',
                    )}
                  >
                    {image && (
                      <div
                        className="absolute h-full w-full rounded-xl bg-cover bg-center bg-no-repeat"
                        style={{
                          backgroundImage: `url(${image})`,
                        }}
                      />
                    )}
                    <Input
                      {...getInputProps({ id: field.name, name: field.name })}
                      type="file"
                      aria-invalid={isInvalid}
                    />
                    <ImageIcon className="text-muted-foreground h-10 w-10" />
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="secondary"
                          className="absolute -right-4 bottom-4 w-fit!"
                        >
                          <Edit2Icon />
                          Edit image
                        </Button>
                      }
                    />
                    <DropdownMenuContent
                      className="w-fit"
                      align="end"
                      sideOffset={10}
                    >
                      <DropdownMenuGroup>
                        <DropdownMenuItem onClick={open}>
                          <UploadIcon />
                          Choose image
                        </DropdownMenuItem>
                        {image && (
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => field.handleChange(null)}
                          >
                            <Trash2Icon />
                            Remove
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              )
            }}
          />
          <form.Field
            name="name"
            children={(field) => {
              const isInvalid =
                field.state.meta.isTouched && !field.state.meta.isValid
              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Name</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(e) => field.handleChange(e.target.value)}
                    aria-invalid={isInvalid}
                    placeholder="John Smith"
                  />
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              )
            }}
          />
          <form.Field
            name="bio"
            children={(field) => {
              const isInvalid =
                field.state.meta.isTouched && !field.state.meta.isValid
              return (
                <Field data-invalid={isInvalid}>
                  <FieldLabel htmlFor={field.name}>Bio</FieldLabel>
                  <InputGroup>
                    <InputGroupTextarea
                      id={field.name}
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={isInvalid}
                      placeholder="John Smith"
                      className="field-sizing-content max-h-[6lh] min-h-[4lh] resize-none"
                    />
                    <InputGroupAddon align="block-end">
                      <InputGroupText className="tabular-nums">
                        {field.state.value.length}/160 characters
                      </InputGroupText>
                    </InputGroupAddon>
                  </InputGroup>
                  {isInvalid && <FieldError errors={field.state.meta.errors} />}
                </Field>
              )
            }}
          />
        </FieldGroup>
      </form>
      <Field orientation="horizontal" className="mt-4">
        <Button type="submit" form="profile-form">
          Update profile
        </Button>
      </Field>
    </>
  )
}
