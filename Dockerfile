# syntax=docker/dockerfile:1.7
# Backend image for all server process roles (api, admin-api, webhook, voice, worker, scheduler, media-scanner).
# The ECS task definition selects the role via the command. Base images are pinned by digest (Dependabot updates them).
# Runtime: distroless, non-root, no shell, no package manager. Node 24 runs the TypeScript sources via type stripping (ADR-022).

FROM node:26.9.0-bookworm-slim@sha256:582460f614631b59b824ac6020533b9bf339c7fdf3a6d7db31abb6b4065f0212 AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
 && find /app -type d -name __tests__ -prune -exec rm -rf {} + \
 && find /app -type f -name "*.test.ts" -delete

# Debian 13 runtime: the nodejs24-debian12 distroless image still ships libssl3 3.0.18 (CVE-2026-31789 critical,
# CVE-2026-28387..28390, CVE-2026-45447). This digest carries libssl3t64 3.5.7-1~deb13u3, which Debian lists as fixed.
# The build stage only installs pure-JS production dependencies (no native addons), so its Debian release doesn't matter.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
WORKDIR /app
# Files stay root-owned and the task runs with a read-only root filesystem; the nonroot user cannot modify code.
COPY --from=build /app /app
USER nonroot
EXPOSE 8080
CMD ["apps/api/src/main.ts"]
