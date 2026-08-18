Welcome to your new TanStack Start app!

# Getting Started

To run this application:

```bash
bun install
bun --bun run dev
```

## Clerk and Convex authentication

Clerk provides authentication and Convex validates Clerk identity tokens. The
browser uses `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_CONVEX_URL`; the Convex
deployment must also have `CLERK_FRONTEND_API_URL` configured as an environment
variable.

Enable Clerk's Convex integration, or create a Clerk JWT template named
`convex`, so the Convex client can request the token used by
`ConvexProviderWithClerk`. Configure the issuer URL separately on each Convex
development and production deployment.

# Building For Production

To build this application for production:

```bash
bun --bun run build
```

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

### Removing Tailwind CSS

If you prefer not to use Tailwind CSS:

1. Remove the demo pages in `src/routes/demo/`
2. Replace the Tailwind import in `src/styles.css` with your own styles
3. Remove `tailwindcss()` from the plugins array in `vite.config.ts`
4. Remove `@tailwindcss/vite` and `tailwindcss` from `package.json`

## Linting & Formatting

This project uses [eslint](https://eslint.org/) and [prettier](https://prettier.io/) for linting and formatting. Eslint is configured using [tanstack/eslint-config](https://tanstack.com/config/latest/docs/eslint). The following scripts are available:

```bash
bun --bun run lint
bun --bun run format
bun --bun run check
```

## Automated Bank Account certification

Run the commit-bound certification from a clean worktree:

```bash
bun run certify:bank-account-money-request
```

The command runs formatting checks, linting, type checking, the complete test
suite, and the production build. It writes the sanitized evidence report to
`docs/certification/bank-account-money-request.md`. The generated report
certifies the commit that existed before the report was written; commit the
report separately so its recorded commit remains reproducible.

## PayTo Payment deterministic certification

Run the Payment safety suite from a clean worktree after securely setting the
same environment, configuration fingerprint, and credential variables used by
the Payment runtime. The command hashes the selected credential in memory and
never writes the credential itself:

```bash
export ZEPTO_ENVIRONMENT=sandbox
export PAYTO_PAYMENT_CONFIGURATION_FINGERPRINT=<configuration-fingerprint>
export ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN=<credential>
bun run certify:pay-to-payment
```

The command verifies every mandatory scenario is present and runnable, then
runs formatting, linting, type checking, the complete test suite, and the
production build. Only after all gates pass at the same clean commit does it
write sanitized evidence to `docs/certification/pay-to-payment.md`. Commit that
report separately so its recorded commit remains reproducible. The report does
not enable production initiation or replace live sandbox evidence and required
approvals.

## PayTo Payment live sandbox certification

Run the provider-connected drill from a clean worktree with the sandbox
credential, a configuration fingerprint, an active sandbox Agreement to use as
an in-memory routing template, and an existing workflow Payment that has live
create/GET evidence:

```bash
export ZEPTO_ENVIRONMENT=sandbox
export PAYTO_PAYMENT_CONFIGURATION_FINGERPRINT=<configuration-fingerprint>
export ZEPTO_SANDBOX_PERSONAL_ACCESS_TOKEN=<credential>
export PAYTO_PAYMENT_LIVE_TEMPLATE_AGREEMENT_UID=<active-sandbox-agreement-uid>
export PAYTO_PAYMENT_LIVE_WORKFLOW_AGREEMENT_ID=<convex-agreement-id>
export PAYTO_PAYMENT_LIVE_WORKFLOW_PAYMENT_ID=<convex-payment-id>
bun run certify:pay-to-payment:live
```

The command creates one-cent, one-payment sandbox Agreements and Payments using
Zepto's documented simulation controls. It records only hashed identifiers and
normalized outcomes in `docs/certification/pay-to-payment-live.md`; credentials,
account details, raw payloads, and webhook bodies remain in memory. Delivery
patterns that Zepto cannot deterministically force are recorded as provider
limitations with deterministic evidence and written Zepto documentation. The
report expires after 30 days and never changes the production gate.

## Deploy with Nitro

This project uses Nitro as a generic server adapter, so it can run on any Node-compatible host.

```bash
npm run build
node dist/server/index.mjs
```

The build output is a self-contained Node server. To deploy, push the `dist/` directory to your host (Render, Fly.io, your own VPS, etc.) and run the server command above.

For host-specific presets (Vercel, Netlify, Cloudflare, AWS Lambda, etc.) and tuning, see https://v3.nitro.build/deploy.

## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `src/routes`.

### Adding A Route

To add a new route to your application just add a new file in the `./src/routes` directory.

TanStack will automatically generate the content of the route file for you.

Now that you have two routes you can use a `Link` component to navigate between them.

### Adding Links

To use SPA (Single Page Application) navigation you will need to import the `Link` component from `@tanstack/react-router`.

```tsx
import { Link } from '@tanstack/react-router'
```

Then anywhere in your JSX you can use it like so:

```tsx
<Link to="/about">About</Link>
```

This will create a link that will navigate to the `/about` route.

More information on the `Link` component can be found in the [Link documentation](https://tanstack.com/router/v1/docs/framework/react/api/router/linkComponent).

### Using A Layout

In the File Based Routing setup the layout is located in `src/routes/__root.tsx`. Anything you add to the root route will appear in all the routes. The route content will appear in the JSX where you render `{children}` in the `shellComponent`.

Here is an example layout that includes a header:

```tsx
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'My App' },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/about">About</Link>
          </nav>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  ),
})
```

More information on layouts can be found in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Server Functions

TanStack Start provides server functions that allow you to write server-side code that seamlessly integrates with your client components.

```tsx
import { createServerFn } from '@tanstack/react-start'

const getServerTime = createServerFn({
  method: 'GET',
}).handler(async () => {
  return new Date().toISOString()
})

// Use in a component
function MyComponent() {
  const [time, setTime] = useState('')

  useEffect(() => {
    getServerTime().then(setTime)
  }, [])

  return <div>Server time: {time}</div>
}
```

## API Routes

You can create API routes by using the `server` property in your route definitions:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/hello')({
  server: {
    handlers: {
      GET: () => json({ message: 'Hello, World!' }),
    },
  },
})
```

## Data Fetching

There are multiple ways to fetch data in your application. You can use TanStack Query to fetch data from a server. But you can also use the `loader` functionality built into TanStack Router to load the data for a route before it's rendered.

For example:

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/people')({
  loader: async () => {
    const response = await fetch('https://swapi.dev/api/people')
    return response.json()
  },
  component: PeopleComponent,
})

function PeopleComponent() {
  const data = Route.useLoaderData()
  return (
    <ul>
      {data.results.map((person) => (
        <li key={person.name}>{person.name}</li>
      ))}
    </ul>
  )
}
```

Loaders simplify your data fetching logic dramatically. Check out more information in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).

# Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

For TanStack Start specific documentation, visit [TanStack Start](https://tanstack.com/start).
