# syntax=docker/dockerfile:1.7
# Backend image for all server process roles (api, admin-api, webhook, voice, worker, scheduler, media-scanner).
# The ECS task definition selects the role via the command. Base images are pinned by digest (Dependabot updates them).
# Runtime: distroless, non-root, no shell, no package manager. Node 24 runs the TypeScript sources via type stripping (ADR-022).

FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile --prod --ignore-scripts \
 && find /app -type d -name __tests__ -prune -exec rm -rf {} + \
 && find /app -type f -name "*.test.ts" -delete

FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
WORKDIR /app
# Files stay root-owned and the task runs with a read-only root filesystem; the nonroot user cannot modify code.
COPY --from=build /app /app
USER nonroot
EXPOSE 8080
CMD ["apps/api/src/main.ts"]
