#!/usr/bin/env bash
# SR-16 deploy gate: refuse any image that is not (1) referenced by digest, (2) keyless-signed by this
# repository's CI workflow on main, and (3) carrying a CycloneDX SBOM attestation from the same identity.
set -euo pipefail

ref="${1:?usage: verify-image.sh <repository>@sha256:<digest>}"
if [[ ! "$ref" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "REFUSED: image must be referenced by an immutable sha256 digest: $ref" >&2
  exit 2
fi
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set (owner/repo)}"

identity="^https://github\.com/${GITHUB_REPOSITORY}/\.github/workflows/ci\.yml@refs/heads/main$"
issuer="https://token.actions.githubusercontent.com"

if ! cosign verify --certificate-identity-regexp "$identity" --certificate-oidc-issuer "$issuer" "$ref" >/dev/null; then
  echo "REFUSED: no valid signature from ${GITHUB_REPOSITORY} CI on main for $ref" >&2
  exit 1
fi
if ! cosign verify-attestation --type cyclonedx --certificate-identity-regexp "$identity" --certificate-oidc-issuer "$issuer" "$ref" >/dev/null; then
  echo "REFUSED: missing or invalid CycloneDX SBOM attestation for $ref" >&2
  exit 1
fi
echo "VERIFIED: signature and SBOM attestation for $ref"
