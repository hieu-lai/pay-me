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
import type * as lib_paymentDestinationCrypto from "../lib/paymentDestinationCrypto.js";
import type * as lib_requireUser from "../lib/requireUser.js";
import type * as lib_userFunctions from "../lib/userFunctions.js";
import type * as migrations from "../migrations.js";
import type * as paymentDestinations from "../paymentDestinations.js";
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
  "lib/paymentDestinationCrypto": typeof lib_paymentDestinationCrypto;
  "lib/requireUser": typeof lib_requireUser;
  "lib/userFunctions": typeof lib_userFunctions;
  migrations: typeof migrations;
  paymentDestinations: typeof paymentDestinations;
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
