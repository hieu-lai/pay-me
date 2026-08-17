/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as lib_agreementCreationPool from "../lib/agreementCreationPool.js";
import type * as lib_moneyRequestIngress from "../lib/moneyRequestIngress.js";
import type * as lib_payIdCapability from "../lib/payIdCapability.js";
import type * as lib_payToAgreementActivation from "../lib/payToAgreementActivation.js";
import type * as lib_payToPaymentProjection from "../lib/payToPaymentProjection.js";
import type * as lib_paymentCreationPool from "../lib/paymentCreationPool.js";
import type * as lib_paymentDestinationCrypto from "../lib/paymentDestinationCrypto.js";
import type * as lib_paymentRetryPool from "../lib/paymentRetryPool.js";
import type * as lib_paymentRetryRateLimiter from "../lib/paymentRetryRateLimiter.js";
import type * as lib_profileImageStorage from "../lib/profileImageStorage.js";
import type * as lib_requireUser from "../lib/requireUser.js";
import type * as lib_userFunctions from "../lib/userFunctions.js";
import type * as lib_userProfile from "../lib/userProfile.js";
import type * as lib_userSearch from "../lib/userSearch.js";
import type * as lib_zepto_agreement from "../lib/zepto/agreement.js";
import type * as lib_zepto_aliasResolution from "../lib/zepto/aliasResolution.js";
import type * as lib_zepto_client from "../lib/zepto/client.js";
import type * as lib_zepto_env from "../lib/zepto/env.js";
import type * as lib_zepto_error from "../lib/zepto/error.js";
import type * as lib_zepto_generated_clients from "../lib/zepto/generated/clients.js";
import type * as lib_zepto_generated_confirmationOfPayee from "../lib/zepto/generated/confirmationOfPayee.js";
import type * as lib_zepto_generated_core from "../lib/zepto/generated/core.js";
import type * as lib_zepto_generated_investigations from "../lib/zepto/generated/investigations.js";
import type * as lib_zepto_generated_merchantReports from "../lib/zepto/generated/merchantReports.js";
import type * as lib_zepto_generated_notifications from "../lib/zepto/generated/notifications.js";
import type * as lib_zepto_generated_payTo from "../lib/zepto/generated/payTo.js";
import type * as lib_zepto_index from "../lib/zepto/index.js";
import type * as lib_zepto_pagination from "../lib/zepto/pagination.js";
import type * as lib_zepto_payment from "../lib/zepto/payment.js";
import type * as lib_zepto_reconciliation from "../lib/zepto/reconciliation.js";
import type * as lib_zepto_webhook from "../lib/zepto/webhook.js";
import type * as lib_zepto_webhookEvents from "../lib/zepto/webhookEvents.js";
import type * as migrations from "../migrations.js";
import type * as moneyRequests from "../moneyRequests.js";
import type * as payToAgreementCreation from "../payToAgreementCreation.js";
import type * as payToAgreementCreationState from "../payToAgreementCreationState.js";
import type * as payToAgreementReconciliation from "../payToAgreementReconciliation.js";
import type * as payToAgreementReconciliationState from "../payToAgreementReconciliationState.js";
import type * as payToPaymentCreation from "../payToPaymentCreation.js";
import type * as payToPaymentOperators from "../payToPaymentOperators.js";
import type * as payToPaymentReconciliation from "../payToPaymentReconciliation.js";
import type * as payToPaymentReconciliationState from "../payToPaymentReconciliationState.js";
import type * as payToPaymentRetry from "../payToPaymentRetry.js";
import type * as payToPayments from "../payToPayments.js";
import type * as paymentDestinations from "../paymentDestinations.js";
import type * as seed from "../seed.js";
import type * as users from "../users.js";
import type * as validators_payToAgreements from "../validators/payToAgreements.js";
import type * as validators_payToPaymentProjections from "../validators/payToPaymentProjections.js";
import type * as validators_payToPayments from "../validators/payToPayments.js";
import type * as validators_paymentDestinations from "../validators/paymentDestinations.js";
import type * as validators_profileImages from "../validators/profileImages.js";
import type * as validators_users from "../validators/users.js";
import type * as validators_zeptoWebhook from "../validators/zeptoWebhook.js";
import type * as zeptoWebhook from "../zeptoWebhook.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  crons: typeof crons;
  http: typeof http;
  "lib/agreementCreationPool": typeof lib_agreementCreationPool;
  "lib/moneyRequestIngress": typeof lib_moneyRequestIngress;
  "lib/payIdCapability": typeof lib_payIdCapability;
  "lib/payToAgreementActivation": typeof lib_payToAgreementActivation;
  "lib/payToPaymentProjection": typeof lib_payToPaymentProjection;
  "lib/paymentCreationPool": typeof lib_paymentCreationPool;
  "lib/paymentDestinationCrypto": typeof lib_paymentDestinationCrypto;
  "lib/paymentRetryPool": typeof lib_paymentRetryPool;
  "lib/paymentRetryRateLimiter": typeof lib_paymentRetryRateLimiter;
  "lib/profileImageStorage": typeof lib_profileImageStorage;
  "lib/requireUser": typeof lib_requireUser;
  "lib/userFunctions": typeof lib_userFunctions;
  "lib/userProfile": typeof lib_userProfile;
  "lib/userSearch": typeof lib_userSearch;
  "lib/zepto/agreement": typeof lib_zepto_agreement;
  "lib/zepto/aliasResolution": typeof lib_zepto_aliasResolution;
  "lib/zepto/client": typeof lib_zepto_client;
  "lib/zepto/env": typeof lib_zepto_env;
  "lib/zepto/error": typeof lib_zepto_error;
  "lib/zepto/generated/clients": typeof lib_zepto_generated_clients;
  "lib/zepto/generated/confirmationOfPayee": typeof lib_zepto_generated_confirmationOfPayee;
  "lib/zepto/generated/core": typeof lib_zepto_generated_core;
  "lib/zepto/generated/investigations": typeof lib_zepto_generated_investigations;
  "lib/zepto/generated/merchantReports": typeof lib_zepto_generated_merchantReports;
  "lib/zepto/generated/notifications": typeof lib_zepto_generated_notifications;
  "lib/zepto/generated/payTo": typeof lib_zepto_generated_payTo;
  "lib/zepto/index": typeof lib_zepto_index;
  "lib/zepto/pagination": typeof lib_zepto_pagination;
  "lib/zepto/payment": typeof lib_zepto_payment;
  "lib/zepto/reconciliation": typeof lib_zepto_reconciliation;
  "lib/zepto/webhook": typeof lib_zepto_webhook;
  "lib/zepto/webhookEvents": typeof lib_zepto_webhookEvents;
  migrations: typeof migrations;
  moneyRequests: typeof moneyRequests;
  payToAgreementCreation: typeof payToAgreementCreation;
  payToAgreementCreationState: typeof payToAgreementCreationState;
  payToAgreementReconciliation: typeof payToAgreementReconciliation;
  payToAgreementReconciliationState: typeof payToAgreementReconciliationState;
  payToPaymentCreation: typeof payToPaymentCreation;
  payToPaymentOperators: typeof payToPaymentOperators;
  payToPaymentReconciliation: typeof payToPaymentReconciliation;
  payToPaymentReconciliationState: typeof payToPaymentReconciliationState;
  payToPaymentRetry: typeof payToPaymentRetry;
  payToPayments: typeof payToPayments;
  paymentDestinations: typeof paymentDestinations;
  seed: typeof seed;
  users: typeof users;
  "validators/payToAgreements": typeof validators_payToAgreements;
  "validators/payToPaymentProjections": typeof validators_payToPaymentProjections;
  "validators/payToPayments": typeof validators_payToPayments;
  "validators/paymentDestinations": typeof validators_paymentDestinations;
  "validators/profileImages": typeof validators_profileImages;
  "validators/users": typeof validators_users;
  "validators/zeptoWebhook": typeof validators_zeptoWebhook;
  zeptoWebhook: typeof zeptoWebhook;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
  r2: import("@convex-dev/r2/_generated/component.js").ComponentApi<"r2">;
  profileImageUploadRateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"profileImageUploadRateLimiter">;
  paymentRetryRateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"paymentRetryRateLimiter">;
  agreementCreationWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"agreementCreationWorkpool">;
  paymentCreationWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"paymentCreationWorkpool">;
  paymentRetryWorkpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"paymentRetryWorkpool">;
};
