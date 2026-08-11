/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as http from "../http.js";
import type * as lib_moneyRequestIngress from "../lib/moneyRequestIngress.js";
import type * as lib_paymentDestinationCrypto from "../lib/paymentDestinationCrypto.js";
import type * as lib_requireUser from "../lib/requireUser.js";
import type * as lib_userFunctions from "../lib/userFunctions.js";
import type * as lib_userSearch from "../lib/userSearch.js";
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
import type * as lib_zepto_webhook from "../lib/zepto/webhook.js";
import type * as migrations from "../migrations.js";
import type * as moneyRequests from "../moneyRequests.js";
import type * as paymentDestinations from "../paymentDestinations.js";
import type * as seed from "../seed.js";
import type * as users from "../users.js";
import type * as validators_paymentDestinations from "../validators/paymentDestinations.js";
import type * as validators_users from "../validators/users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  http: typeof http;
  "lib/moneyRequestIngress": typeof lib_moneyRequestIngress;
  "lib/paymentDestinationCrypto": typeof lib_paymentDestinationCrypto;
  "lib/requireUser": typeof lib_requireUser;
  "lib/userFunctions": typeof lib_userFunctions;
  "lib/userSearch": typeof lib_userSearch;
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
  "lib/zepto/webhook": typeof lib_zepto_webhook;
  migrations: typeof migrations;
  moneyRequests: typeof moneyRequests;
  paymentDestinations: typeof paymentDestinations;
  seed: typeof seed;
  users: typeof users;
  "validators/paymentDestinations": typeof validators_paymentDestinations;
  "validators/users": typeof validators_users;
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
};
