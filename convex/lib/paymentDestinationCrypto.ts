import { ConvexError } from 'convex/values'
import { env } from '../_generated/server'
import type {
  EncryptedValue,
  PaymentDestinationInput,
  ProtectedPaymentDestination,
} from '../validators/paymentDestinations'
import { paymentDestinationInputValidator } from '../validators/paymentDestinations'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const AES_GCM_NONCE_BYTES = 12
const AES_256_KEY_BYTES = 32

function paymentDestinationType(input: PaymentDestinationInput) {
  return input.type
}

function invalidInput(message: string): never {
  throw new ConvexError({ code: 'INVALID_PAYMENT_DESTINATION', message })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decryptionFailed(): never {
  throw new ConvexError({
    code: 'PAYMENT_DESTINATION_DECRYPTION_FAILED',
    message: 'The payment destination could not be decrypted.',
  })
}

function base64ToBytes(value: string, name: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    throw new ConvexError({
      code: 'PAYMENT_DESTINATION_CRYPTO_CONFIG_INVALID',
      message: `${name} must be valid base64.`,
    })
  }
}

function encryptionKeyMap(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(env.PAYMENT_DESTINATION_ENCRYPTION_KEYS)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((value) => typeof value !== 'string')
    ) {
      throw new Error('invalid key map')
    }
    return parsed as Record<string, string>
  } catch {
    throw new ConvexError({
      code: 'PAYMENT_DESTINATION_CRYPTO_CONFIG_INVALID',
      message:
        'PAYMENT_DESTINATION_ENCRYPTION_KEYS must be a JSON object of base64 keys by version.',
    })
  }
}

async function importEncryptionKey(version: string): Promise<CryptoKey> {
  const encodedKey = encryptionKeyMap()[version]
  if (!encodedKey) {
    throw new ConvexError({
      code: 'PAYMENT_DESTINATION_ENCRYPTION_KEY_NOT_FOUND',
      message: `No payment destination encryption key exists for version ${version}.`,
    })
  }

  const keyBytes = base64ToBytes(encodedKey, `Encryption key ${version}`)
  if (keyBytes.byteLength !== AES_256_KEY_BYTES) {
    throw new ConvexError({
      code: 'PAYMENT_DESTINATION_CRYPTO_CONFIG_INVALID',
      message: `Encryption key ${version} must decode to 32 bytes.`,
    })
  }

  return await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function fingerprint(value: string): Promise<string> {
  const keyBytes = base64ToBytes(
    env.PAYMENT_DESTINATION_FINGERPRINT_KEY,
    'PAYMENT_DESTINATION_FINGERPRINT_KEY',
  )
  if (keyBytes.byteLength < AES_256_KEY_BYTES) {
    throw new ConvexError({
      code: 'PAYMENT_DESTINATION_CRYPTO_CONFIG_INVALID',
      message:
        'The payment destination fingerprint key must be at least 32 bytes.',
    })
  }
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(value),
  )
  return bytesToBase64(new Uint8Array(signature))
}

function maskAccountNumber(value: string): string {
  const displayAccountNumber = value.replace(/[ -]/g, '')
  const visibleLength = Math.min(
    4,
    Math.max(0, displayAccountNumber.length - 1),
  )
  const suffix =
    visibleLength === 0 ? '' : displayAccountNumber.slice(-visibleLength)
  return `••••${suffix}`
}

function maskedDisplay(input: PaymentDestinationInput): string {
  switch (input.type) {
    case 'bban':
      return `Bank account ${maskAccountNumber(input.value.slice(7))}`
    case 'alias_phone':
      return `**** *** ${input.value.slice(-3)}`
    case 'alias_email': {
      const [local, domain] = input.value.split('@') as [string, string]
      return `${[...local][0]}***@${domain}`
    }
    case 'alias_abn':
      return `** *** *** ${input.value.slice(-3)}`
    case 'alias_organisation_identifier':
      return `${[...input.value][0]}***`
  }
}

function fingerprintSource(input: PaymentDestinationInput): string {
  return `${input.type}\u0000${input.value}`
}

async function encryptValue(
  value: string,
  key: CryptoKey,
  keyVersion: string,
): Promise<EncryptedValue> {
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    textEncoder.encode(value),
  )
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    nonce: bytesToBase64(nonce),
    keyVersion,
  }
}

async function decryptValue(value: EncryptedValue): Promise<string> {
  const key = await importEncryptionKey(value.keyVersion)
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(value.nonce, 'Payment destination nonce'),
      },
      key,
      base64ToBytes(value.ciphertext, 'Payment destination ciphertext'),
    )
    return textDecoder.decode(plaintext)
  } catch {
    decryptionFailed()
  }
}

export async function protectPaymentDestination(
  input: PaymentDestinationInput,
): Promise<ProtectedPaymentDestination> {
  const keyVersion = env.PAYMENT_DESTINATION_CURRENT_ENCRYPTION_KEY_VERSION
  if (!keyVersion) {
    throw new ConvexError({
      code: 'PAYMENT_DESTINATION_CRYPTO_CONFIG_INVALID',
      message:
        'The current payment destination encryption key version is empty.',
    })
  }
  const key = await importEncryptionKey(keyVersion)
  const common = {
    maskedDisplay: maskedDisplay(input),
    fingerprint: await fingerprint(fingerprintSource(input)),
  }
  return {
    type: paymentDestinationType(input),
    ...common,
    ...(await encryptValue(JSON.stringify(input), key, keyVersion)),
  }
}

export async function decryptPaymentDestination(
  destination: EncryptedValue & { type: PaymentDestinationInput['type'] },
): Promise<PaymentDestinationInput> {
  const plaintext = await decryptValue(destination)
  try {
    const input = paymentDestinationInputValidator.parse(JSON.parse(plaintext))
    if (paymentDestinationType(input) !== destination.type) decryptionFailed()
    return input
  } catch {
    decryptionFailed()
  }
}

export function normalizeLabel(value: string | null): string | undefined {
  if (value === null) return undefined
  const normalized = value.normalize('NFC').trim()
  if (!normalized || normalized.length > 80) {
    invalidInput(
      'Label must be between 1 and 80 characters, or null to remove it.',
    )
  }
  return normalized
}
