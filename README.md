# databazaar-mcp

MCP server for [DataBazaar](https://databazaar.io) — the data marketplace where AI agents discover, preview, purchase, **and sell** datasets.

> **DataBazaar is a marketplace, not a payment network.** All paid transactions
> are processed by Stripe ([Stripe Connect](https://stripe.com/connect) for
> seller payouts; [Stripe Billing](https://stripe.com/billing) for
> subscriptions). Funds move from the buyer's card to a registered seller's
> Stripe-Connected bank account, with DataBazaar collecting a 3% platform fee.
> No cryptocurrency, no peer-to-peer asset transfers, no money-transmission —
> the legal structure is the same as eBay or Etsy: an online marketplace
> where the marketplace operator does not hold or move user funds outside
> the regulated payments processor.

## Quick Start (Claude.ai — remote connector)

For public discovery, connect to **`https://api.databazaar.io/mcp/public`** using
Streamable HTTP with no authentication. It exposes `search_datasets`, `get_dataset`,
`preview_sample`. Full downloads (including free data), purchases, private
history, and writes require the authenticated endpoint.

Run a public search → sample preview example with Python 3 (no packages):

```bash
curl -fsS --max-time 20 https://databazaar.io/examples/first-retrieval.py -o first-retrieval.py
python3 first-retrieval.py --mcp
```

Expected: `success: true`, `scope: sample_only`, sample rows, and elapsed seconds.
This does not measure a full retrieval.
Without `--mcp`, the same example uses REST. See [the guide](https://databazaar.io/agent#quickstart).

For full datasets (even free ones) and account operations, DataBazaar runs an authenticated remote MCP server at `https://api.databazaar.io/mcp`.
Claude.ai discovers OAuth via the standard RFC 8414 metadata document and
self-registers as a client via RFC 7591 Dynamic Client Registration — no
manual setup beyond clicking "Authorize" in the popup.

After signing up and authorizing the agent, call `get_download_url` with `dataset_id`.
For the Python full-data check, set `DATABAZAAR_API_KEY` in the environment and run
`python3 first-retrieval.py --download` (add `--mcp` for the authenticated transport).
It validates all 11 rows and times retrieval. Account setup is required first and
sample timings must not be reported as end-to-end onboarding success.

## Quick Start (stdio — Claude Desktop / Cursor)

```bash
npx databazaar-mcp
```

Search and samples work without credentials. To download full data, run
`npx -y databazaar-mcp auth login` or use an account API key from [databazaar.io/operator/keys](https://databazaar.io/operator/keys).

## Quick Start (Hosted HTTP — long-lived service)

```bash
npx --package databazaar-mcp databazaar-mcp-http
# Listens on port 8788 by default
# MCP endpoint: POST http://localhost:8788/mcp
# Health check: GET  http://localhost:8788/health
```

## Configuration

Set these environment variables before running:

| Variable | Required | Description |
|---|---|---|
| `DATABAZAAR_API_KEY` | For full downloads/account tools | Your API key (`dbz_live_...`) |
| `DATABAZAAR_API_URL` | No | Override API endpoint (default: `https://api.databazaar.io`) |
| `DATABAZAAR_BUDGET_LIMIT_USD` | No | Budget hint for the client; configure enforced purchase limits on your account API key |
| `DATABAZAAR_MCP_PORT` | No | HTTP transport port (default: `8788`) |

## Claude Desktop / Cursor Setup (stdio)

Add to your MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "databazaar": {
      "command": "npx",
      "args": ["-y", "databazaar-mcp"]
    }
  }
}
```

## Hosted HTTP Transport Setup

Run `databazaar-mcp-http` as a long-lived process. Each HTTP caller supplies its own Bearer account credential; the server never lends an environment credential to callers. For managed account authorization, use https://api.databazaar.io/mcp.

```bash
# Start the HTTP MCP server
DATABAZAAR_MCP_PORT=8788 npx --package databazaar-mcp databazaar-mcp-http

# Configure your agent framework to connect via HTTP:
# URL: http://your-host:8788/mcp
# Method: POST (Streamable HTTP transport per MCP spec)
```

## Available Tools

### Search & Discovery

- **`find_data_for_task`** — Task-based dataset recommendation with `why_relevant` explanations
- **`search_datasets`** — Keyword + faceted search across the marketplace
- **`check_coverage`** — Look up whether a known public source is already listed
- **`get_dataset`** — Full metadata including `checkout_url` and `human_pitch`
- **`preview_sample`** — Sample rows + optional synthesized answer (no purchase required)
- **`get_related_datasets`** — Similar datasets by tag overlap in the same category
- **`log_data_gap`** — Record an unmet data need; optionally auto-creates a bounty

### Purchase

- **`buy_now`** — Purchase a dataset immediately (free datasets need no payment method)

### After Purchase

- **`get_download_url`** — Get a signed 1-hour download URL (free datasets: no purchase needed)
- **`list_purchases`** — List all purchases for this API key
- **`get_purchase_receipt`** — Cost-benefit receipt showing time saved vs. money spent; forward `human_summary` to your operator
- **`share_finding`** — Share an analysis finding derived from a purchased dataset; returns a shareable URL

### Listing & Selling

- **`suggest_listing`** — Propose a dataset you produced for listing on DataBazaar; returns a one-click approval URL
- **`create_listing`** — Create a new draft dataset listing
- **`get_upload_urls`** — Get signed URLs to upload sample and full dataset files
- **`confirm_upload`** — Confirm file upload and trigger sample generation
- **`get_listing_status`** — Check listing status (poll for sample generation)
- **`update_listing`** — Update metadata on a draft or active listing
- **`set_schema`** — Set the data schema describing columns/fields
- **`publish_listing`** — Publish a draft listing to the marketplace

### Communication

- **`contact_seller`** — Send a message to a dataset seller before committing to a purchase

## Tool safety classification

Every tool below carries an MCP `annotations` block declaring `readOnlyHint` or
`destructiveHint` so connector hosts can surface the correct user prompt. Tools
that move money are marked `destructiveHint` and require interactive operator
consent on first use.

| Category | Read-only | Destructive |
|---|---|---|
| Discovery | `search_datasets`, `get_dataset`, `preview_sample`, `find_data_for_task`, `check_coverage`, `get_related_datasets` | `log_data_gap` |
| Purchase | — | `buy_now` |
| Delivery | `get_download_url`, `list_purchases`, `get_purchase_receipt` | `share_finding`, `suggest_listing` |
| Selling | `get_listing_status` | `create_listing`, `get_upload_urls`, `confirm_upload`, `update_listing`, `set_schema`, `publish_listing` |
| Messaging | — | `contact_seller` |
| Query | `query_dataset` | — |

## Payments and money handling

`buy_now` is the only tool that initiates a charge. It:

1. Authorize a Stripe charge against an operator-registered card or saved
   payment method — no funds are held by DataBazaar at any point.
2. Settle through Stripe Connect to a seller's verified bank account, with
   DataBazaar deducting a 3% platform fee from the gross sale.
3. Are subject to a 24-hour escrow window before payout (a Stripe-held timer,
   not a DataBazaar-held custody account) so disputes can be raised.
4. Cannot transfer cryptocurrency, securities, gift cards, or any other asset
   class. The marketplace lists only data files; the payments rail is
   regulated card payments via Stripe.

This MCP server therefore does not fall under the Connectors Directory's
"money/cryptocurrency/financial asset transfers" disqualifier — it is a
marketplace integration, structurally identical to a Shopify/eBay/Etsy
connector that lets an agent place an order on a third-party storefront.

## Privacy and data handling

- **Privacy policy:** [databazaar.io/legal/privacy](https://databazaar.io/legal/privacy)
- **Terms of service:** [databazaar.io/legal/terms](https://databazaar.io/legal/terms)
- The MCP server stores OAuth tokens locally at `~/.config/databazaar/token.json`
  (mode 0600). No conversation contents, prompts, or chat history are ever sent
  to the DataBazaar API — only the explicit tool arguments shown in each tool's
  inputSchema.
- DataBazaar collects only operational data needed for the marketplace
  (account email, purchases, listings, messages between buyer and seller).
- Stripe receives card details directly from the buyer's browser via Stripe
  Elements / Checkout — DataBazaar never touches PAN, CVC, or expiration.

## Support

DataBazaar's mail domain is `databazaar.com` (Google Workspace). The legal
pages above are the source of truth for current contact addresses.

- Privacy: [privacy@databazaar.com](mailto:privacy@databazaar.com)
- Legal / terms: [legal@databazaar.com](mailto:legal@databazaar.com)
- General support: [support@databazaar.com](mailto:support@databazaar.com)
- Security disclosures: [security@databazaar.com](mailto:security@databazaar.com)

## Resources

- **`databazaar://categories`** — All available dataset categories
- **`databazaar://recipes`** — Worked example flows: find→buy→download, post bounty when missing, check coverage before scraping, etc.
- **`databazaar://onboarding`** — Plain-English explanation of DataBazaar for your operator; includes a paste-ready pitch paragraph
- **`databazaar://agent/identity`** — Your agent identity and config
- **`databazaar://agent/spending`** — Spending summary and purchase history

## Example Workflows

**Buying:**
```
1. find_data_for_task("train rent prediction model for SF 2024")
2. preview_sample(dataset_id, question="average rent by neighborhood")
3. buy_now(dataset_id)
4. get_download_url(purchase_id)
5. get_purchase_receipt(purchase_id)  → forward human_summary to operator
```

**Selling:**
```
1. create_listing(title, description, category, pricing_type)
2. get_upload_urls(dataset_id)
3. (PUT file bytes to the returned signed URL)
4. confirm_upload(dataset_id, full_data_path)
5. get_listing_status(dataset_id)  → poll until sample ready
6. publish_listing(dataset_id, tos_confirmed=true, listing_terms_version="2026-10-09")
```

## Releasing a new version

The package is published to **two** places: npm (the artifact) and the
official MCP Registry at `registry.modelcontextprotocol.io` (the metadata
entry). Both need to be updated for a release to be fully propagated.

Prerequisites (one-time):
- `npm login` as `shagarwal` (the package owner)
- 2FA is enabled; have an authenticator handy for `--otp`

Release loop:

```bash
# 1. Bump the version in BOTH files (keep them in sync)
#    - packages/mcp/package.json       : "version"
#    - packages/mcp/server.json        : "version" AND "packages[0].version"

# 2. Build and publish to npm
cd packages/mcp
pnpm build
npm publish --access public --otp=XXXXXX

# 3. Verify npm has the new version
curl -s https://registry.npmjs.org/databazaar-mcp | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print('latest:', d['dist-tags']['latest'])"

# 4. Commit + push the version bumps
git add packages/mcp/package.json packages/mcp/server.json
git commit -m "chore(mcp): release x.y.z"
git push origin main

# 5. Update the MCP Registry entry
#    Trigger the "Publish to MCP Registry" GitHub Actions workflow:
gh workflow run "Publish to MCP Registry" --ref main
gh run watch   # optional: follow the run

# 6. Verify the registry reflects the new version
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=databazaar" | \
  python3 -m json.tool | head -30
```

The workflow (`.github/workflows/publish-mcp-registry.yml`) uses GitHub Actions
OIDC for auth — no secrets required, and it sidesteps the mcp-publisher device-
flow rate limits you hit running it locally. See that file if the auth or publish
step ever needs adjusting.

Invariants to preserve on every release:
- **`package.json` must keep `mcpName: "io.github.shagarwal/databazaar"`** —
  this is how the registry validates npm ownership. Remove it and the
  registry publish will fail.
- **`server.json` description is capped at 100 characters** — the registry
  rejects longer. Long copy belongs in this README, `llms.txt`, and the
  homepage; `server.json` is the short blurb only.
- **`bin` values in `package.json` must NOT have a `./` prefix** — npm 11
  silently strips the prefix and then rejects the result, removing the bin
  entries from the published tarball. Use `dist/index.js`, not `./dist/index.js`.

## Links

- [Browse datasets](https://databazaar.io/browse)
- [Get an API key](https://databazaar.io/operator/keys)
- [API docs](https://api.databazaar.io/openapi.json)
- [MCP discovery](https://api.databazaar.io/.well-known/mcp.json)
- [npm package page](https://www.npmjs.com/package/databazaar-mcp)
- [Registry listing](https://registry.modelcontextprotocol.io/v0/servers?search=databazaar)

## Tested workflows and integrations

- [Export DeepSearchQA to CSV](https://databazaar.io/guides/deepsearchqa-csv?utm_source=npm&utm_campaign=mcp-readme)
- [Inspect historical stock bars](https://databazaar.io/guides/stock-bars-analysis?utm_source=npm&utm_campaign=mcp-readme)
- [MCP, AI SDK and LangChain examples](https://databazaar.io/integrations?utm_source=npm&utm_campaign=mcp-readme)

`min_quality_score` uses **0–100** in this release. It measures sample structure, not customer ratings or factual accuracy. See the [published rubric](https://databazaar.io/quality).

Full downloads always require a signed-in account, including free data. Public discovery is available through the local server without a token or the hosted `/mcp/public` endpoint.

Source and issues: https://github.com/shagarwal/databazaar-mcp. Marketplace feedback: https://databazaar.io/feedback.

### Listing source and reuse terms

Before publishing, provide `documentation.source_name` through `create_listing` or
`update_listing`. Name the original source or creator; a source URL is optional.
Coverage dates may use `documentation.coverage_status: "not_applicable"`.
`documentation.update_frequency` optionally describes whether this is a fixed
snapshot or receives updates, and whether later versions are included.

`license` and `documentation.license_url` are optional custom reuse terms. If both
are blank, accepting [the listing terms](https://databazaar.io/legal/terms#dataset-reuse)
grants commercial use, modification, redistribution, and model training without
attribution under DataBazaar Open Use. Access charges still apply. Only confirm
`tos_confirmed: true` and `listing_terms_version: "2026-10-09"` with the supplier's
authorization. The same acceptance is required when changing live reuse terms.
Older listings without recorded acceptance remain unspecified, not automatically open.

## Build and test this public client

```bash
npm install
npm test
npm run build
node dist/index.js
```

This repository mirrors the released MCP client. The marketplace API and web app
are developed separately. Search and samples work without signing in; account
credentials are required for full retrieval and account operations. The published
npm package is the supported installation route: `npx -y databazaar-mcp`.

The checked-in `server.json` is the registry record for this release. Historical
registry versions may still reference the private development repository; use
this public repository for the client source and issue tracker.
