import migrations from '@convex-dev/migrations/convex.config.js'
import workpool from '@convex-dev/workpool/convex.config'
import { defineApp } from 'convex/server'
import { v } from 'convex/values'

const app = defineApp({
  env: {
    CLERK_FRONTEND_API_URL: v.string(),
    CLERK_SECRET_KEY: v.string(),
    CLERK_WEBHOOK_SIGNING_SECRET: v.string(),
    PAYMENT_DESTINATION_ENCRYPTION_KEYS: v.string(),
    PAYMENT_DESTINATION_CURRENT_ENCRYPTION_KEY_VERSION: v.string(),
    PAYMENT_DESTINATION_FINGERPRINT_KEY: v.string(),
    MONEY_REQUEST_INGRESS_ATTESTATION_SECRET: v.string(),
    ZEPTO_ENVIRONMENT: v.optional(
      v.union(v.literal('sandbox'), v.literal('production')),
    ),
    ZEPTO_PERSONAL_ACCESS_TOKEN: v.optional(v.string()),
    ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN: v.optional(v.string()),
  },
})

app.use(migrations)
app.use(workpool, { name: 'agreementCreationWorkpool' })

export default app
