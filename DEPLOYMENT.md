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

## Deploy vs. install

`forge deploy` publishes new code to an environment; `forge install` is what makes an app usable
on a site. The app is already installed on `dashtech.atlassian.net` for both environments, so a
code-only change needs nothing but a deploy — the installed app picks it up.

The exception is **scope changes**. When `manifest.yml` gains a new permission, the existing
installation stays pinned to the old scope set until it is upgraded, so the new code runs
without the permission it expects. The pipeline handles this with a `forge install --upgrade`
step after each deploy, which is idempotent and a no-op for code-only changes:

- **development** runs it with `--confirm-scopes`, auto-granting new permissions. Low risk, and
  it keeps the environment usable without manual steps.
- **production** runs it *without* `--confirm-scopes`. A code-only change upgrades silently; a
  scope change makes the step **fail on purpose** rather than silently widening the app's
  permissions on the live site. When that happens, a Jira admin grants consent deliberately —
  either by approving the app's new scopes in **Manage apps**, or by running the install
  manually:

  ```bash
  forge install --upgrade --confirm-scopes --site dashtech.atlassian.net --product jira --environment production
  ```

A first-time install on a *new* site (not the case today) is still a manual `forge install`
without `--upgrade`.

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
