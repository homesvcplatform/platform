#!/usr/bin/env bash
# Applies main-branch protection and the dev/test deployment environments to the GitHub repository.
# Run once by a repository admin after the repo exists (founder action). Requires the gh CLI, authenticated.
set -euo pipefail
repo="${1:?usage: apply-repo-protection.sh <owner/repo>}"
root="$(cd "$(dirname "$0")/../.." && pwd)"

gh api -X POST "repos/$repo/rulesets" --input "$root/.github/rulesets/main-protection.json" >/dev/null
echo "Ruleset main-protection applied."

# Phase 2 has only dev and test deployment environments (no production).
for env in dev test; do
  gh api -X PUT "repos/$repo/environments/$env" \
    -F 'deployment_branch_policy[protected_branches]=true' \
    -F 'deployment_branch_policy[custom_branch_policies]=false' >/dev/null
  echo "Environment $env created (deploys only from protected branches). Add required reviewers in the UI or via API."
done
gh api -X PUT "repos/$repo/vulnerability-alerts" >/dev/null && echo "Dependabot alerts enabled."
gh api -X PATCH "repos/$repo" -F 'security_and_analysis[secret_scanning][status]=enabled' \
  -F 'security_and_analysis[secret_scanning_push_protection][status]=enabled' >/dev/null && echo "Secret scanning + push protection enabled."
