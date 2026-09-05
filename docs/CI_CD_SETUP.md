# CI/CD Setup — Branch Flow & Deployment Gating

```
feature/*  →  integration  →  main
              (Render staging) (Render production)

feature/* branches: never merge to main, never deploy anywhere.
```

---

## 1. Commit these files (already created)

- `.github/workflows/ci.yml` — lint/typecheck/test/build on every PR into `integration` or `main`
- `.github/workflows/enforce-branch-flow.yml` — fails any PR into `main` that isn't from `integration`
- `.github/workflows/docker-publish.yml` — builds and pushes a Docker image to GHCR on every push to `main` or `integration`, then triggers the matching Render Deploy Hook
- `render.yaml` — Render Blueprint defining both services (production, staging) and their databases
- `docker-compose.yml` — local dev: API + Postgres together
- `Dockerfile` — production image build

---

## 2. GitHub Branch Protection (manual — Settings → Branches)

### Protect `main`

1. Repo → **Settings → Branches → Add branch protection rule**
2. Branch name pattern: `main`
3. Enable:
   - ✅ Require a pull request before merging (require at least 1 approval if you want a review gate, optional for a solo/two-person team)
   - ✅ Require status checks to pass before merging → select **`quality-checks`** and **`check-source-branch`**
   - ✅ Require branches to be up to date before merging
   - ✅ Do not allow bypassing the above settings (include yourself — otherwise "never ever" isn't actually enforced)
   - ✅ Restrict who can push to matching branches (optional — blocks direct pushes entirely, forces everything through a PR)

### Protect `integration`

Same steps, branch name pattern `integration`. Require status check **`quality-checks`** only (the source-branch check doesn't apply here — `integration` legitimately receives PRs from any `feature/*` branch).

**This is the step that actually makes "never ever" true.** `enforce-branch-flow.yml` can report failure, but without "Require status checks to pass" + "Do not allow bypassing" on `main`, a failing check doesn't block a merge — it's just a warning.

---

## 3. Render Setup

Unlike Vercel, Render's image-based services don't watch git branches directly — they run whatever image is at a given registry tag, and redeploy when explicitly told to. `render.yaml` defines two services (`atlas-ai-api-production` pulling `:latest`, `atlas-ai-api-staging` pulling `:integration`), and `docker-publish.yml` is what actually connects a branch push to a redeploy.

### One-time setup

1. **Add a registry credential.** Render Dashboard → Workspace Settings → Credentials → add a credential named `ghcr-credentials`, using a GitHub Personal Access Token with `read:packages` scope. GHCR images are private by default — Render needs this to pull them.
2. **Sync the Blueprint.** Render Dashboard → New → Blueprint → connect this repo → Render reads `render.yaml` and creates both services + both databases.
3. **Set the `sync: false` env vars manually** for each service in the Render dashboard (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `WEB_APP_ORIGIN`) — these are deliberately not in the committed Blueprint.
4. **Copy each service's Deploy Hook URL.** Each service's Settings tab has a unique Deploy Hook URL. Add them as GitHub Actions secrets:
   - `RENDER_DEPLOY_HOOK_PRODUCTION` ← from `atlas-ai-api-production`
   - `RENDER_DEPLOY_HOOK_STAGING` ← from `atlas-ai-api-staging`

   (Repo → Settings → Secrets and variables → Actions → New repository secret)

### The actual flow, end to end

Push to `main` → `docker-publish.yml` builds, tags `ghcr.io/.../atlas-ai-api:latest`, pushes it, then `curl`s `RENDER_DEPLOY_HOOK_PRODUCTION` → Render pulls the fresh `:latest` image and redeploys production. Same mechanism for `integration` → `:integration` tag → staging. This is what closes the "image rebuilt but nothing redeployed" gap from earlier — the Deploy Hook call is the explicit trigger, not an assumption that Render notices the tag changed on its own.

### Before this will actually pass health checks

`render.yaml` sets `healthCheckPath: /health` on both services. Confirm a `GET /health` route exists in the Nest app (a trivial controller returning `{ status: 'ok' }` is enough) — if it doesn't exist yet, Render will mark the service unhealthy immediately after every deploy.

---

## 4. GitHub Actions Permissions (required for Docker image publishing)

The `docker-publish.yml` workflow pushes to GitHub Container Registry using the automatically-generated `GITHUB_TOKEN`. By default, many repos have this token capped to **read-only**, which silently overrides the `permissions: packages: write` declared inside the workflow file itself — the repo-level setting is a ceiling the workflow can't exceed on its own.

1. Repo → **Settings → Actions → General → Workflow permissions**
2. Select **"Read and write permissions"**
3. Save

Without this change, `docker-publish.yml` will run on every merge to `main` but fail at the push step with a 403 — worth checking this before assuming the workflow itself is broken if that happens.

---

## 5. GHCR Package Visibility

The first time `docker-publish.yml` runs successfully, it creates a new package at `ghcr.io/<you>/atlas-ai-api`. By default this is **private**, visible only to you and the repo.

Since Render is the consumer now: the `ghcr-credentials` registry credential (§3) handles authentication regardless of visibility, so there's no need to make the package public. Keep it private.

---

## 6. Operational rule worth adopting: keep `integration` synced after every production release

A gap this two-branch flow can quietly develop: once `integration → main` is merged, `main` and `integration` are identical — until the next feature lands on `integration`. That's fine under normal flow. But if you ever need an emergency hotfix directly on `main` (production is broken, can't wait for the full feature→integration→main cycle), `main` and `integration` diverge silently, and your next regular release could overwrite the hotfix.

**If you anticipate ever needing that emergency path**, decide now, not mid-incident:

- Either explicitly forbid it (all fixes, even urgent ones, go through `integration` first — simplest, matches your "never ever" philosophy, but means no fast path during an outage)
- Or allow a narrow `hotfix/*` exception that can merge directly to `main`, with a rule that `main` is immediately merged back into `integration` right after

If you're not expecting to need hotfixes soon, the simplest fix is just: **after every `integration → main` merge, merge `main` back into `integration`** as a matter of habit, so they never drift even by accident.

---

## 7. Verifying it works

- Open a PR from a `feature/*` branch straight into `main` → `check-source-branch` should fail immediately, merge button should be blocked.
- Push to a `feature/*` branch → confirm no image is built (workflow doesn't even trigger — `feature/*` isn't in `docker-publish.yml`'s branch list) and no Render service redeploys.
- Merge `feature/x` into `integration` → confirm a new `:integration` image appears in GHCR under Packages, and `atlas-ai-api-staging` shows a fresh deploy in the Render dashboard shortly after.
- Merge `integration` into `main` → confirm a new `:latest` image appears in GHCR, and `atlas-ai-api-production` shows a fresh deploy in Render.
- Hit `https://atlas-ai-api-staging.onrender.com/health` and the production equivalent — both should return a healthy response, not Render's default error page.
