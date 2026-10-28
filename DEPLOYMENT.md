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

## Where the app is installed

| Environment | Sites | Workflow variable |
| --- | --- | --- |
| development | `dashtech.atlassian.net` | `FORGE_DEV_SITE` |
| production | `dashtech.atlassian.net`, `sportscentral.atlassian.net` | `FORGE_PROD_SITES` |

**Adding a site to production means adding it to `FORGE_PROD_SITES` too.** Installing it is not
enough — see below for what the list is actually for.

## Deploy vs. install

`forge deploy` publishes new code to an environment; `forge install` is what makes an app usable
on a site. Both environments are already installed, and `forge deploy` reaches *every*
installation of that environment at once, so a code-only change needs nothing but a deploy —
there is no per-site rollout and no way to pin one site to an older build.

The exception is **scope changes**. When `manifest.yml` gains a new permission, each existing
installation stays pinned to the scope set it was installed with until it is upgraded
individually, so the new code runs on that site without the permission it expects. This is why
`FORGE_PROD_SITES` exists: the pipeline runs `forge install --upgrade` once per site after each
deploy, which is idempotent and a no-op for code-only changes.

- **development** runs it with `--confirm-scopes`, auto-granting new permissions. Low risk, and
  it keeps the environment usable without manual steps. It also falls back to a fresh install
  if the development app has been removed from the site.
- **production** runs it *without* `--confirm-scopes`, for every site in `FORGE_PROD_SITES`. A
  code-only change upgrades silently; a scope change makes the step **fail on purpose** rather
  than silently widening the app's permissions on a live site. Every site is attempted even
  after one fails — stopping early would leave the rest both un-upgraded and unreported — and
  the job then fails naming exactly which sites were left behind.

When that happens, a Jira admin on each named site grants consent deliberately: either by
approving the app's new scopes in **Manage apps**, or by running the install manually:

```bash
forge install --upgrade --confirm-scopes --site <site>.atlassian.net --product jira --environment production
```

A first-time install on a **new** site is a manual `forge install` *without* `--upgrade`, run
from the repo root (the command needs `manifest.yml` in the working directory):

```bash
forge install --site <site>.atlassian.net --product jira --environment production
```

Then add that site to `FORGE_PROD_SITES`. Note the app's distribution is set to **Sharing**, so
an account does not need to own or contribute to the app to install it — but managing it (e.g.
`forge install list`) does require that access.

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
