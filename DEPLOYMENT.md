# Deployment via Git / CI

Code changes are deployed through GitHub Actions (`.github/workflows/deploy.yml`), not by
running `forge deploy` manually from a laptop.

## How it works

- **Push to `main`** → runs the full validation gate (`npm run ci`: manifest check, `forge
  lint`, type-check, tests with coverage, eslint, semgrep) → if it passes, auto-deploys to the
  **development** environment. Nothing further happens automatically — development is for
  verification, not real users.
- **Production deploy** is manual and gated: run the workflow by hand from the Actions tab
  (*Run workflow* → target: `production`). It still runs the same validation gate first, then
  requires approval from a reviewer on the `production` GitHub Environment before `forge
  deploy --environment production` runs.

`forge deploy` publishes new code to an environment. It does **not** by itself make the app
usable on a site — that's `forge install`, which only needs to be run once per environment/site
combination (or again when scopes/permissions change). Run `forge install --environment
<env> --site dashtech.atlassian.net --product jira` manually the first time, and after any
manifest permission change; the CI pipeline does not do this for you.

## One-time setup required (do this in the GitHub repo, not via Claude)

1. **Repo secrets** — Settings → Secrets and variables → Actions:
   - `FORGE_EMAIL` — the Atlassian account email used for Forge deploys (e.g. a service/admin
     account, not a personal one, if you want deploys to survive an individual leaving).
   - `FORGE_API_TOKEN` — an API token for that account, generated at
     https://id.atlassian.com/manage-profile/security/api-tokens.

2. **`production` Environment** — Settings → Environments → New environment → name it exactly
   `production` → add **Required reviewers** (yourself and/or teammates). This is what makes the
   production job pause for approval instead of deploying immediately.

3. **`development` Environment** — Settings → Environments → New environment → name it
   `development`. No required reviewers needed; it exists so the environment-scoped secrets/URL
   (if any) are separated from production.

## Rollback

Forge keeps deploy history per environment. To roll back, `forge deploy --environment
<env> --version <previous-version>` (see `forge versions` / release notes in Atlassian's docs) —
this isn't currently wired into the pipeline and would be run manually if ever needed.
