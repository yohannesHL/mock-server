# Mock Server

A developer workspace for creating and serving Mockoon environments from one dashboard. The control plane stores provider environments, while each deployed environment runs in its own Mockoon CLI process behind a stable subdomain.

## Start locally

Requirements: Node.js 24 or newer and npm.

```sh
npm install
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:5173`. Sign in with the values in `.env` (`admin@example.test` / `change-this-before-hosting` by default). Change those values before exposing the service to a network.

The dashboard starts with provider templates for OpenAI, Anthropic, Google Ads, Meta Ads, Meta Publishing, YouTube, TikTok, LinkedIn, and X. Create an environment from a template, deploy it, and use the displayed URL in the application under test. To keep current API clients drop-in compatible, every environment gets a distinct host, such as `http://google-ads.mockserver.localhost:4310`.

The seven marketing-app templates preserve the existing 109 provider routes and OAuth, upload, error, and delay scenarios. OpenAI and Anthropic templates include authenticated API examples. The UI supports endpoint creation, response status/body/latency editing, route deletion, and advanced Mockoon JSON editing.

## Build and run

```sh
npm run build
npm start
```

The service binds to `HOST:PORT` (default `[::]:4310`). The SQLite-compatible database and runtime snapshots live under `data/`. Deployed environment state is restored after a service restart. Before production, set a strong `ADMIN_PASSWORD`, a random `SESSION_SECRET` with at least 32 characters, a persistent `DATA_DIR`, and `BASE_DOMAIN` to the domain used by the dashboard.

For a single-host deployment, put the service behind a TLS reverse proxy and route both `BASE_DOMAIN` and `*.BASE_DOMAIN` to it. The root domain serves the control panel; each environment subdomain routes to its isolated Mockoon process. Keep `PORT` private to the proxy and bind the application to the container interface. Multi-host worker scheduling and team membership are future extensions; this first version is a single-node service.

## Provider environment files

`providers/` contains the reusable Mockoon data files. The files in `providers/marketing-app/` are moved from the marketing-app repository. OpenAI and Anthropic are maintained as additional starter environments. The dashboard imports the files at startup, and changes made in the dashboard are stored independently in the database.

To validate the checked-in environments:

```sh
npm run fixtures:validate
```

## Marketing app integration

Create a project in the dashboard to get a scoped CLI token. The project repository contains `mock-server.config.json`; it lists the APIs the CLI should make available. A config can use a bundled provider template, a Mockoon JSON file relative to the project, or inline environment data. The first CLI run creates project environments from their templates. Later runs preserve edits made in the dashboard unless the config supplies its own `file` or `data` value.

For example:

```json
{
  "name": "marketing-app",
  "environments": [
    { "name": "OpenAI", "slug": "openai", "template": "openai" },
    { "name": "Google Ads", "slug": "google-ads", "template": "google-ads" }
  ]
}
```

Set the token and dashboard URL in your shell, then run the CLI from the project directory:

```sh
export MOCK_SERVER_URL=http://127.0.0.1:4310
export MOCK_SERVER_TOKEN='paste-project-token-here'
npm exec --yes --package=github:yohannesHL/mock-server -- mock-server start --project .
```

The CLI reads `mock-server.config.json`, starts each configured environment on the service, prints its generated URL, and keeps the project active with heartbeats. The dashboard lists the project and URLs as active while the CLI is connected. When the process stops or loses contact, the service stops accepting requests for those project URLs. If a token is lost, rotate it from the project row in the dashboard; the previous token is revoked.

The app itself only receives its normal per-provider API base URLs. Put the generated URLs in `PROVIDER_API_BASE_URLS`, for example:

```sh
PROVIDER_API_BASE_URLS='{"openai":"http://marketing-app-openai.mockserver.localhost:4310","google-ads":"http://marketing-app-google-ads.mockserver.localhost:4310"}'
```

In a hosted environment, set `MOCK_SERVER_URL` to the control-plane domain, such as `https://mocks.example.com`, and route both the root domain and `*.mocks.example.com` through TLS to the service. The project token is scoped to its project and stored hashed by the service.
