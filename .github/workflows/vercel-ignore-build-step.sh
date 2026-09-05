#!/bin/bash
#
# Vercel "Ignored Build Step" script.
# Configure in: Vercel Project Settings → Git → Ignored Build Step
#   Command: bash scripts/vercel-ignore-build-step.sh
#
# Semantics (per Vercel's convention):
#   exit 0  -> SKIP this deployment
#   exit 1  -> PROCEED with this deployment
#
# Only 'main' (production) and 'integration' (preview) are ever built.
# Every other branch — including all feature/* branches — is skipped
# entirely, so it never gets a Vercel URL at all.

if [[ "$VERCEL_GIT_COMMIT_REF" == "main" || "$VERCEL_GIT_COMMIT_REF" == "integration" ]]; then
  echo "✅ Branch '$VERCEL_GIT_COMMIT_REF' is allowed to deploy — proceeding."
  exit 1
else
  echo "🛑 Branch '$VERCEL_GIT_COMMIT_REF' is not main or integration — skipping deployment."
  exit 0
fi