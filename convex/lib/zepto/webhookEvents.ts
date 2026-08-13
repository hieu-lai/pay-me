import type { ProviderAgreementState } from '../../validators/payToAgreements'
import type { ProviderPayToPaymentState } from '../../validators/payToPayments'

const agreementStateByEventType: Partial<
  Record<string, ProviderAgreementState>
> = {
  'payto_agreement.activated': 'active',
  'payto_agreement.cancelled': 'cancelled',
  'payto_agreement.declined': 'declined',
  'payto_agreement.expired': 'expired',
  'payto_agreement.failed': 'failed',
  'payto_agreement.reactivated': 'active',
  'payto_agreement.suspended': 'suspended',
}

const paymentStateByEventType: Partial<
  Record<string, ProviderPayToPaymentState>
> = {
  'payto_payment.failed': 'failed',
  'payto_payment.pending': 'pending',
  'payto_payment.settled': 'settled',
  'payto_payment.under_investigation': 'under_investigation',
}

export function agreementStateForWebhookEvent(eventType: string) {
  return agreementStateByEventType[eventType]
}

export function paymentStateForWebhookEvent(eventType: string) {
  return paymentStateByEventType[eventType]
}

export function classifyZeptoWebhookEvent(
  resourceType: string,
  eventType: string,
) {
  if (resourceType === 'payto_agreement') {
    return agreementStateForWebhookEvent(eventType) === undefined
      ? ('unsupported_event' as const)
      : ('supported_agreement' as const)
  }
  if (resourceType === 'payto_payment') {
    return paymentStateForWebhookEvent(eventType) === undefined
      ? ('unsupported_event' as const)
      : ('supported_payment' as const)
  }
  return 'unsupported_resource' as const
}
