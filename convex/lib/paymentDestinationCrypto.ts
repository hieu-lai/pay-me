import { ConvexError } from 'convex/values'
import { env } from '../_generated/server'
import type {
  EncryptedPaymentDestination,
  EncryptedValue,
  PaymentDestinationInput,
  ProtectedPaymentDestination,
} from '../validators/paymentDestinations'
import { paymentDestinationInputValidator } from '../validators/paymentDestinations'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const AES_GCM_NONCE_BYTES = 12
const AES_256_KEY_BYTES = 32
const MAX_ACCOUNT_NAME_LENGTH = 120
const MAX_ACCOUNT_NUMBER_LENGTH = 9
const MAX_ORGANISATION_IDENTIFIER_LENGTH = 256

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

function normalizeAccountName(value: string): string {
  const normalized = value.normalize('NFC').trim()
  if (!normalized || normalized.length > MAX_ACCOUNT_NAME_LENGTH) {
    invalidInput('Account name must be between 1 and 120 characters.')
  }
  return normalized
}

function normalizeBsb(value: string): string {
  const normalized = value.replace(/[\s-]/g, '')
  if (!/^\d{6}$/.test(normalized)) {
    invalidInput('BSB must contain exactly 6 digits.')
  }
  return normalized
}

function normalizeAccountNumber(value: string): string {
  const normalized = value.normalize('NFC').trim()
  if (
    !normalized ||
    normalized.length > MAX_ACCOUNT_NUMBER_LENGTH ||
    !/^[A-Za-z0-9 -]+$/.test(normalized)
  ) {
    invalidInput(
      'Account number must be 1 to 9 letters, digits, spaces, or hyphens.',
    )
  }
  return normalized
}

function normalizeMobile(value: string): string {
  const compact = value.replace(/[\s()-]/g, '')
  if (/^04\d{8}$/.test(compact)) return `+61-${compact.slice(1)}`
  if (/^\+614\d{8}$/.test(compact)) return `+61-${compact.slice(3)}`
  invalidInput('Mobile PayID must be an Australian 04 or +614 mobile number.')
}

function normalizeEmail(value: string): string {
  const normalized = value.normalize('NFC').trim().toLowerCase()
  if (
    normalized.length > 256 ||
    !/^[\x21-\x7e]+$/.test(normalized) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    invalidInput('Email PayID must be a valid email address.')
  }
  return normalized
}

function isValidAbn(value: string): boolean {
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
  const digits = [...value].map(Number)
  digits[0] -= 1
  return (
    digits.reduce((sum, digit, index) => sum + digit * weights[index], 0) %
      89 ===
    0
  )
}

function normalizeAbn(value: string): string {
  const normalized = value.replace(/\s/g, '')
  if (!/^\d{11}$/.test(normalized) || !isValidAbn(normalized)) {
    invalidInput('ABN PayID must be a valid 11-digit ABN.')
  }
  return normalized
}

function normalizeOrganisationIdentifier(value: string): string {
  const normalized = value.normalize('NFC').trim().toLowerCase()
  if (
    !normalized ||
    normalized.length > MAX_ORGANISATION_IDENTIFIER_LENGTH ||
    !/^[\x20-\x7e]+$/.test(normalized)
  ) {
    invalidInput(
      'Organisation Identifier must be between 1 and 256 printable characters.',
    )
  }
  return normalized
}

function normalizeInput(
  input: PaymentDestinationInput,
): PaymentDestinationInput {
  if (input.kind === 'bankAccount') {
    return {
      kind: 'bankAccount',
      accountName: normalizeAccountName(input.accountName),
      bsb: normalizeBsb(input.bsb),
      accountNumber: normalizeAccountNumber(input.accountNumber),
    }
  }

  const value = (() => {
    switch (input.payIdType) {
      case 'mobile':
        return normalizeMobile(input.value)
      case 'email':
        return normalizeEmail(input.value)
      case 'abn':
        return normalizeAbn(input.value)
      case 'organisationIdentifier':
        return normalizeOrganisationIdentifier(input.value)
    }
  })()
  return { kind: 'payId', payIdType: input.payIdType, value }
}

function maskAccountName(value: string): string {
  return value
    .split(/\s+/)
    .map((part) => {
      const [first, ...rest] = [...part]
      return `${first}${'*'.repeat(rest.length)}`
    })
    .join(' ')
}

function maskBsb(value: string): string {
  return `***-${value.slice(-3)}`
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
  if (input.kind === 'bankAccount') {
    return `Bank account ${maskAccountNumber(input.accountNumber)}`
  }
  switch (input.payIdType) {
    case 'mobile':
      return `**** *** ${input.value.slice(-3)}`
    case 'email': {
      const [local, domain] = input.value.split('@') as [string, string]
      return `${[...local][0]}***@${domain}`
    }
    case 'abn':
      return `** *** *** ${input.value.slice(-3)}`
    case 'organisationIdentifier':
      return `${[...input.value][0]}***`
  }
}

function fingerprintSource(input: PaymentDestinationInput): string {
  return input.kind === 'bankAccount'
    ? `bankAccount\u0000${input.bsb}\u0000${input.accountNumber}`
    : `payId\u0000${input.payIdType}\u0000${input.value}`
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
  rawInput: PaymentDestinationInput,
): Promise<ProtectedPaymentDestination> {
  const input = normalizeInput(rawInput)
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
  if (input.kind === 'bankAccount') {
    const [accountName, bsb, accountNumber] = await Promise.all([
      encryptValue(input.accountName, key, keyVersion),
      encryptValue(input.bsb, key, keyVersion),
      encryptValue(input.accountNumber, key, keyVersion),
    ])
    return {
      kind: 'bankAccount',
      ...common,
      maskedAccountName: maskAccountName(input.accountName),
      maskedBsb: maskBsb(input.bsb),
      maskedAccountNumber: maskAccountNumber(input.accountNumber),
      accountName,
      bsb,
      accountNumber,
    }
  }

  return {
    kind: 'payId',
    payIdType: input.payIdType,
    ...common,
    ...(await encryptValue(JSON.stringify(input), key, keyVersion)),
  }
}

export async function decryptPaymentDestination(
  destination: EncryptedPaymentDestination,
): Promise<PaymentDestinationInput> {
  if (destination.kind === 'bankAccount') {
    const [accountName, bsb, accountNumber] = await Promise.all([
      decryptValue(destination.accountName),
      decryptValue(destination.bsb),
      decryptValue(destination.accountNumber),
    ])
    try {
      return paymentDestinationInputValidator.parse({
        kind: 'bankAccount',
        accountName,
        bsb,
        accountNumber,
      })
    } catch {
      decryptionFailed()
    }
  }

  const plaintext = await decryptValue(destination)
  try {
    return paymentDestinationInputValidator.parse(JSON.parse(plaintext))
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
