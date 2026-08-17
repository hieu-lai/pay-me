import type { Doc } from '../_generated/dataModel'
import { env } from '../_generated/server'

export type ProfileImageDeliveryMode = 'development' | 'public_custom_domain'

const keyPattern = /^profile-images\/(staging|assets)\/[a-z0-9_-]+$/

export type ProfileImageStorageConfiguration = {
  bucket: string
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  cdnOrigin: string
  deliveryMode: ProfileImageDeliveryMode
}

export function validateProfileImageObjectKey(
  objectKey: string,
  expectedKind?: 'staging' | 'asset',
): string {
  const match = keyPattern.exec(objectKey)
  if (
    !match ||
    (expectedKind === 'staging' && match[1] !== 'staging') ||
    (expectedKind === 'asset' && match[1] !== 'assets')
  ) {
    throw new Error('Invalid Profile Image object key.')
  }
  return objectKey
}

export function validateProfileImageCdnOrigin(
  value: string,
  mode: ProfileImageDeliveryMode,
): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('PROFILE_IMAGE_CDN_ORIGIN must be a valid origin.')
  }

  if (
    url.origin !== value ||
    url.username !== '' ||
    url.password !== '' ||
    url.hostname.endsWith('.') ||
    (url.protocol !== 'https:' && url.protocol !== 'http:')
  ) {
    throw new Error(
      'PROFILE_IMAGE_CDN_ORIGIN must contain only an HTTP(S) scheme and host.',
    )
  }

  if (
    mode === 'public_custom_domain' &&
    (url.protocol !== 'https:' ||
      url.hostname === 'r2.dev' ||
      url.hostname.endsWith('.r2.dev'))
  ) {
    throw new Error(
      'Public Profile Image delivery requires an HTTPS custom domain.',
    )
  }

  return url.origin
}

export function validateProfileImageStorageConfiguration(
  configuration: ProfileImageStorageConfiguration,
): ProfileImageStorageConfiguration {
  for (const [name, value] of Object.entries(configuration)) {
    if (name !== 'deliveryMode' && value.trim() === '') {
      throw new Error(`Profile Image storage configuration ${name} is empty.`)
    }
  }
  let endpoint: URL
  try {
    endpoint = new URL(configuration.endpoint)
  } catch {
    throw new Error('R2_ENDPOINT must be a valid HTTPS URL.')
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== ''
  ) {
    throw new Error('R2_ENDPOINT must be a valid HTTPS URL.')
  }
  return {
    ...configuration,
    cdnOrigin: validateProfileImageCdnOrigin(
      configuration.cdnOrigin,
      configuration.deliveryMode,
    ),
  }
}

export function profileImageStorageConfiguration() {
  return validateProfileImageStorageConfiguration({
    bucket: env.R2_BUCKET,
    endpoint: env.R2_ENDPOINT,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    cdnOrigin: env.PROFILE_IMAGE_CDN_ORIGIN,
    deliveryMode: env.PROFILE_IMAGE_DELIVERY_MODE,
  })
}

export function profileImageUrl(
  source: Doc<'users'>['profileImageSource'],
  configuration?: { origin: string; mode: ProfileImageDeliveryMode },
): string | undefined {
  if (source === undefined) return
  if (source.kind === 'legacyExternal') return source.url

  const runtimeConfiguration = configuration
    ? undefined
    : profileImageStorageConfiguration()
  const mode = configuration?.mode ?? runtimeConfiguration!.deliveryMode
  const origin = validateProfileImageCdnOrigin(
    configuration?.origin ?? runtimeConfiguration!.cdnOrigin,
    mode,
  )
  return `${origin}/${validateProfileImageObjectKey(source.objectKey, 'asset')}`
}
