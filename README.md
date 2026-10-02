# hussamfaroug-com Worker CI/CD

## What this does

This repo deploys the `hussamfaroug-com` Cloudflare Worker via GitHub Actions on every push to `main`.

## Setup

### 1. Create a Cloudflare API token

1. Go to [Account API tokens](https://dash.cloudflare.com/?to=/:account/api-tokens)
2. Click **Create Token**
3. Select **Edit Cloudflare Workers** template
4. Scope it to your account only
5. Copy the token value

### 2. Add GitHub repository secrets

Go to your GitHub repo → **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret name | Value |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | `ee1ab37acbedc81c70af09ffc0c67501` |
| `CLOUDFLARE_API_TOKEN` | (the token you just created) |

### 3. Push to main

Any push to `main` now automatically deploys the Worker via `wrangler deploy`.

You can also trigger a deploy manually from the **Actions** tab → **Run workflow**.

## Files

- `.github/workflows/deploy.yml` — the CI/CD workflow
- `wrangler.toml` — Wrangler configuration (Worker name, entry point, KV binding, route, cron trigger)
- `hussamfaroug-com-worker.js` — the Worker code

## Branch protection (fixes CASB findings)

After your first successful workflow run, enable branch protection in GitHub:

1. Repo → **Settings → Branches → Add branch protection rule**
2. Branch name pattern: `main`
3. Enable:
   - Require pull request before merging
   - Dismiss stale pull request approvals when new commits are pushed
   - Do not allow bypassing the above settings
   - Require status checks to pass before merging (select "Deploy hussamfaroug-com Worker")
4. Click **Create**

This clears all 4 CASB findings from your Cloudflare Security Center.

## ⚠️ FLAGS binding

The Worker code references `env.FLAGS.getBooleanValue("maintenance-mode", false)`. This binding is **not** in `wrangler.toml` because it's not configured in the dashboard. The code has a try/catch around it, so if the binding is missing, the Worker still works — maintenance mode just won't function.

## Cron trigger

No cron trigger is configured because the Worker does not have a `scheduled()` handler.
