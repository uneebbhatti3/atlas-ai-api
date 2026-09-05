# CI/CD Setup — Branch Flow & Deployment Gating

Three pieces work together to enforce this flow. All three are required — any one missing leaves a gap.

```
feature/*  →  integration  →  main
              (Vercel preview)  (Vercel production)

feature/* branches: never merge to main, never deploy anywhere.
```

---

## 1. Commit these files (already created)

- `.github/workflows/ci.yml` — lint/typecheck/test/build on every PR into `integration` or `main`
- `.github/workflows/enforce-branch-flow.yml` — fails any PR into `main` that isn't from `integration`
- `scripts/vercel-ignore-build-step.sh` — tells Vercel to skip building anything except `main`/`integration`

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

## 3. Vercel Project Settings

1. **Project Settings → Git → Production Branch** → set to `main`. This is what makes a merge to `main` a _production_ deployment and everything else a _preview_.
2. **Project Settings → Git → Ignored Build Step** → set the command to:
   ```
   bash scripts/vercel-ignore-build-step.sh
   ```
   Make sure the script is executable: `chmod +x scripts/vercel-ignore-build-step.sh` and commit that permission.
3. Result: pushing/merging to `feature/*` → Vercel skips the build entirely, no deployment of any kind is created. Merging to `integration` → preview deployment. Merging to `main` → production deployment.

---

## 4. Operational rule worth adopting: keep `integration` synced after every production release

A gap this two-branch flow can quietly develop: once `integration → main` is merged, `main` and `integration` are identical — until the next feature lands on `integration`. That's fine under normal flow. But if you ever need an emergency hotfix directly on `main` (production is broken, can't wait for the full feature→integration→main cycle), `main` and `integration` diverge silently, and your next regular release could overwrite the hotfix.

**If you anticipate ever needing that emergency path**, decide now, not mid-incident:

- Either explicitly forbid it (all fixes, even urgent ones, go through `integration` first — simplest, matches your "never ever" philosophy, but means no fast path during an outage)
- Or allow a narrow `hotfix/*` exception that can merge directly to `main`, with a rule that `main` is immediately merged back into `integration` right after

If you're not expecting to need hotfixes soon, the simplest fix is just: **after every `integration → main` merge, merge `main` back into `integration`** as a matter of habit, so they never drift even by accident.

---

## 5. Verifying it works

- Open a PR from a `feature/*` branch straight into `main` → `check-source-branch` should fail immediately, merge button should be blocked.
- Push to a `feature/*` branch → check Vercel dashboard, confirm no deployment was created at all.
- Merge `feature/x` into `integration` → confirm a **Preview** deployment appears in Vercel.
- Merge `integration` into `main` → confirm a **Production** deployment appears.
