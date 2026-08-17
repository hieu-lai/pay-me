# Cloudflare R2 public Profile Image delivery safeguards

Checked: 2026-08-17

## Question

What must PayMe's backend specification and deployment runbook require when it derives stable public Profile Image URLs for opaque, immutable R2 objects: custom-domain setup per deployment, safe key-to-path construction, production restrictions, cache behavior, purge mechanics, and realistic deletion guarantees?

## Recommendation

Keep the decisions in [Choose the Profile Image delivery boundary](https://github.com/hieu-lai/pay-me/issues/49) and [Define the owned R2 Profile Image lifecycle](https://github.com/hieu-lai/pay-me/issues/52), with one important clarification: a cleanup obligation that confirms an object is absent from R2 proves origin-storage deletion, not immediate revocation of every public copy. R2 object operations are strongly consistent, but a custom domain with caching deliberately relaxes what a public URL can return; Cloudflare says a deleted object can remain available from cache until expiry or purge ([R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)).

The implementation-ready specification should therefore require:

1. One explicit HTTPS Profile Image CDN origin per deployed environment, configured separately from the stored R2 key and verified to be the active custom domain for that environment's bucket.
2. A production release gate that rejects an `r2.dev` origin and verifies that the bucket's independent `r2.dev` access is disabled.
3. A restricted application-owned key grammar and one canonical key-to-URL algorithm; never persist or accept a client-supplied public URL for an owned image.
4. `Cache-Control: public, max-age=31536000, immutable` as R2 HTTP metadata on the sealed asset, plus a Cloudflare Cache Rule that makes the owned-asset prefix cache-eligible regardless of filename extension.
5. Unique keys that are never overwritten or reused. Replacement changes the profile association to a new URL, so it does not depend on invalidating the old URL.
6. R2 deletion as the durable cleanup success condition. A single-file CDN purge may be an optional best-effort tightening step, but neither it nor R2 deletion can retract copies already held by browsers, other caches, or recipients.

These requirements preserve the chosen public-CDN boundary without implying a privacy or revocation guarantee that the boundary cannot provide.

## Per-deployment custom-domain configuration

R2 buckets are private until public access is explicitly enabled. Cloudflare supports two independent public access paths: a domain the account controls and a Cloudflare-managed `r2.dev` hostname. Attaching a custom domain enables Cloudflare caching and the surrounding WAF/access/bot controls; `r2.dev` does not provide those features ([R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/), [Enable cache in an R2 bucket](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/)).

A custom domain is an attachment to a named bucket. The domain's zone must be in the same Cloudflare account as the bucket, and the attachment has independently observable `enabled`, ownership-status, and SSL-status fields. Cloudflare exposes list, get, attach, update, and remove operations for this configuration ([R2 custom-domain API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/)). This makes the following deployment model an application inference from Cloudflare's configuration boundary:

- Give each independently deployed environment that serves Profile Images an explicit `PROFILE_IMAGE_CDN_ORIGIN`, such as `https://profiles.example.com` for production and a different host for staging. The value is an origin only: HTTPS scheme and host, with no credentials, query, fragment, or application path.
- The configured origin must correspond to the same R2 bucket used by that deployment's component credentials. Do not derive it from the S3 endpoint, guess it from the bucket name, share a production host with a preview bucket, or fall back to another environment.
- Store only the immutable object key in Convex. Construct `imageUrl` on reads from the deployment's configured origin and the stored key. This keeps a custom-domain change out of persisted User records and preserves the source-of-truth decision in Choose the Profile Image delivery boundary.
- Fail closed during production startup/deployment validation if the origin is absent, non-HTTPS, an `r2.dev` hostname, or not on an allowlist controlled by PayMe.

The deployment runbook should verify through the R2 custom-domain API (or the equivalent dashboard state) that `enabled` is true and both ownership and SSL statuses are `active` before publishing the application. Connection can spend several minutes in `Initializing`, so merely creating the DNS record is not a sufficient readiness check ([R2 public buckets: connect a custom domain](https://developers.cloudflare.com/r2/buckets/public-buckets/#connect-a-bucket-to-a-custom-domain), [R2 custom-domain API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/)).

Cloudflare's custom-domain API reports a default minimum TLS version of 1.0 when `minTLS` is not set. The runbook should explicitly set the minimum TLS version to PayMe's production policy rather than inherit that default, and enable HTTPS-only access for the zone ([R2 custom-domain API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/), [R2 data security](https://developers.cloudflare.com/r2/reference/data-security/)).

## Production restriction and `r2.dev`

Cloudflare labels `r2.dev` as a rate-limited development endpoint and says it should be used only for development. Caching, WAF, access controls, and bot management require a custom domain, and pointing a CNAME at the `r2.dev` hostname is explicitly unsupported for production ([R2 public buckets: public development URL](https://developers.cloudflare.com/r2/buckets/public-buckets/#public-development-url)).

Enabling a custom domain does not disable `r2.dev`. The two access paths are independent, and disabling or removing one domain does not affect the others ([R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)). Production must therefore both use the approved custom domain and set the bucket's managed-domain `enabled` state to false. Cloudflare exposes the managed-domain state separately through `GET` and `PUT /accounts/{account_id}/r2/buckets/{bucket_name}/domains/managed` ([R2 managed-domain API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/)). This prevents an ungoverned `r2.dev` URL from bypassing custom-domain controls; it does not make the approved Profile Image URLs private.

Development may deliberately use `r2.dev`, but tests performed there do not validate CDN caching or purge behavior. A staging custom domain is needed for production-parity checks because `r2.dev` does not support caching ([Enable cache in an R2 bucket](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/)).

## Stable URL construction and object-key encoding

Use an application-owned key grammar for sealed assets, for example:

```text
profile-images/assets/<lowercase UUID or lowercase hex token>
```

The exact random-token format is an implementation choice, but the public grammar should permit only fixed literal `/` separators and unreserved ASCII key characters such as lowercase letters, digits, `-`, `_`, and `.`. It should reject empty segments, `.` and `..`, `%`, `?`, `#`, backslashes, control characters, whitespace, and Unicode. This is a PayMe safety invariant, not an R2 restriction: R2 supports Unicode and NFC-normalizes Unicode-equivalent key names, which creates avoidable interoperability complexity for a URL identifier ([R2 Unicode interoperability](https://developers.cloudflare.com/r2/reference/unicode-interoperability/)).

For a validated origin and a key that matches that grammar, the canonical public URL is the origin, one `/`, and the key. There is no query string or fragment. The backend must use the same helper for API responses, verification requests, and any cache purge so byte-for-byte URL identity cannot drift.

If a generic operational helper ever has to support arbitrary existing R2 keys, split the key on `/`, percent-encode each segment, and join the encoded segments with literal `/`. Do not percent-encode the entire key as one component. Cloudflare's R2 object API explicitly requires slashes inside an object key to remain literal and requires other reserved characters to be percent-encoded ([R2 Get Object API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/get/)). Cloudflare also requires UTF-8 encoded URLs for single-file purge, and the URL path is case-sensitive ([Cloudflare single-file purge](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/)). Restricting new keys to a small ASCII grammar makes this fallback unnecessary in the normal Profile Image flow.

The never-overwrite rule from Define the owned R2 Profile Image lifecycle is also a cache-safety rule. Cloudflare can cache a 404 for a key and can continue serving an overwritten object's old bytes until TTL expiry or purge ([R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)). Sealing and verifying a new unique object before exposing its URL, then never reusing that key, avoids both negative-cache and overwrite ambiguity.

## Cache headers and cache eligibility

R2 supports `Cache-Control` and `Content-Type` as per-object HTTP metadata, including through uploads and the object API ([R2 upload objects](https://developers.cloudflare.com/r2/objects/upload-objects/), [R2 Objects API](https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects)). The sealing step decided in Define the owned R2 Profile Image lifecycle should write the detected image media type and exactly:

```http
Cache-Control: public, max-age=31536000, immutable
```

Under Cloudflare's documented semantics, `public` permits shared caching, `max-age` makes the response stale after the specified seconds, and `immutable` tells browsers not to revalidate an unexpired response. Cloudflare states that `immutable` changes browser behavior but has no effect on public caches such as Cloudflare itself ([Cloudflare Cache-Control directives](https://developers.cloudflare.com/cache/concepts/cache-control/)). The one-year browser commitment is therefore real; it is not merely an edge-cache hint.

Cloudflare does not cache every file type by default. Profile Image asset keys are opaque and need not end in `.png`, `.jpg`, `.webp`, or another extension, so production must configure a Cache Rule that marks the precise owned-asset path prefix as eligible for caching rather than relying on default filename classification. Cloudflare's R2 cache guidance explicitly calls out default cached-file-type limits and directs applications to Cache Rules for other content ([Enable cache in an R2 bucket](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/), [R2 public-bucket caching](https://developers.cloudflare.com/r2/buckets/public-buckets/#caching)). Scope the rule to the approved image hostname and `profile-images/assets/` prefix; do not use a zone-wide cache-everything rule.

The cache configuration should respect the object's existing `Cache-Control` header and avoid a custom cache key based on cookies, headers, or query parameters. Cloudflare Cache Rules can override origin TTLs, while custom cache keys complicate exact-URL invalidation ([Cloudflare Cache-Control interaction with Edge Cache TTL](https://developers.cloudflare.com/cache/concepts/cache-control/#edge-cache-ttl), [purging custom cache keys](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-cache-key/)). The deployment acceptance check should fetch a sample sealed asset and verify the expected `Content-Type`, `Cache-Control`, canonical URL, and an eventual cache hit rather than assuming stored metadata and edge behavior match.

## Deletion, purge, and revocation guarantees

Direct R2 object deletion is strongly consistent: after a successful delete, direct reads through the Workers binding or S3 API immediately report that the object does not exist. Cached custom-domain reads are expressly outside that guarantee. Cloudflare says a deleted object may still be returned by cache and instructs users to purge if deletion must be reflected at that access path ([R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)).

Cloudflare recommends single-file purge by exact URL. It removes the cached resource across Cloudflare CDN data centers, after which a new request returns to the origin. The API is `POST /zones/{zone_id}/purge_cache` with a `files` array and an API token carrying `Cache Purge`; all plans support URL purge ([Cloudflare purge API](https://developers.cloudflare.com/api/resources/cache/methods/purge/), [single-file purge](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/)). If PayMe ever adds automatic purge, its durable operation must use the exact canonical custom-domain URL and retry the purge independently of R2 deletion. It should not use purge-everything.

Single-file purge only clears Cloudflare's CDN cache. Cloudflare explicitly states that purging its cache does not affect an asset stored in a visitor's browser, and a high Browser Cache TTL can keep that asset there until expiry ([Edge and Browser Cache TTL](https://developers.cloudflare.com/cache/how-to/edge-browser-cache-ttl/)). The `public` directive also permits other caches to store the response ([Cloudflare Cache-Control directives](https://developers.cloudflare.com/cache/concepts/cache-control/)). No storage delete or CDN purge can retract an already downloaded or copied image.

Consequently, the practical guarantees for the chosen design are:

| Event                                 | Guarantee                                                                                                                                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activate a replacement                | Authenticated profile reads point to a new unique URL after the Convex mutation commits; the new URL does not depend on invalidating the old object.                                                                                |
| Delete the old R2 object              | Direct R2 reads report absence immediately after successful deletion, but a custom-domain cache may still serve the old bytes.                                                                                                      |
| Purge the exact old URL               | Cloudflare CDN copies are invalidated, subject to using the correct URL/cache key; browser and third-party copies are unaffected.                                                                                                   |
| Wait for `max-age=31536000` to elapse | Conforming caches should treat their stored response as stale, but this is not proof that every recipient erased a copy.                                                                                                            |
| Disable `r2.dev`                      | Prevents future reads through that managed hostname only; other enabled custom domains and existing copies are unaffected.                                                                                                          |
| Disable/remove the custom domain      | Prevents future reads through that hostname once the configuration takes effect; other enabled access paths and existing copies are unaffected ([R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)). |

The first four rows synthesize the cited R2 consistency, purge, browser-cache, and Cache-Control semantics. They are the limit of what the backend specification may promise.

## Reconciliation with the existing Wayfinder decisions

Choose the Profile Image delivery boundary already accepts that replaced or removed objects may remain retrievable from intermediary caches for the cache lifetime. The Cloudflare facts support that decision. The backend should not describe removal as immediate revocation, and it does not need a Cloudflare Cache Purge credential in the ordinary cleanup path unless the product deliberately adopts a stronger best-effort edge-removal objective later.

Define the owned R2 Profile Image lifecycle says cleanup retries until R2 confirms the exact key is absent. Keep that success condition, but name it **origin deletion complete**, not **public URL revoked**. The cleanup record already captures the exact immutable key, so it is also sufficient to derive the one exact URL needed for an optional future purge without trusting user input.

The one-day staging lifecycle remains a safety net rather than an exact deletion deadline. Cloudflare says lifecycle-expired objects are typically removed within 24 hours of their expiration value and existing objects can take longer during rule migration ([R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)). Staging objects must not be addressable through any returned public Profile Image URL, so this timing does not weaken the active-image contract.

## Specification and release checklist

- [ ] Define and validate `PROFILE_IMAGE_CDN_ORIGIN` separately for every deployed environment.
- [ ] Verify the origin's R2 custom-domain attachment is enabled with active ownership and SSL status for the deployment's bucket.
- [ ] Require HTTPS and explicitly set the custom domain's minimum TLS policy.
- [ ] In production, reject `r2.dev` as the configured origin and verify managed `r2.dev` access is disabled on the bucket.
- [ ] Store only the owned R2 key; derive the URL through one canonical helper.
- [ ] Enforce the restricted opaque key grammar and keep `/` separators literal.
- [ ] Never overwrite or reuse a sealed asset key, and never expose its URL before sealing and verification complete.
- [ ] Store the detected `Content-Type` and `Cache-Control: public, max-age=31536000, immutable` as R2 HTTP metadata.
- [ ] Configure a hostname-and-prefix-scoped Cache Rule so extensionless opaque assets are cache-eligible.
- [ ] Keep the cache key independent of cookies, headers, and query strings.
- [ ] Verify a deployed sample object's canonical URL, response headers, cache hit behavior, R2 deletion behavior, and exact-URL purge procedure.
- [ ] Document that cleanup confirms origin deletion, while old public copies may survive in browsers or other caches for up to their freshness lifetime or longer if copied outside cache controls.

## Newly surfaced decisions

No new Wayfinder decision ticket is required for the current destination. The prior public-delivery decision explicitly accepted cache-lifetime retrievability, and the lifecycle decision already chose R2 absence as cleanup completion. The implementation handoff should incorporate the configuration and terminology safeguards above.

If the product later requires prompt takedown of a Profile Image from the public URL, that is a change to the delivery boundary rather than a small cleanup refinement. It should reopen the public-versus-private delivery decision and consider shorter browser TTLs, authenticated delivery, or another revocable serving layer; automatic Cloudflare purge alone cannot provide that guarantee.
