# syntax=docker/dockerfile:1

# Build both runtime targets from the same checkout and dependency store. The manifest-only copy keeps
# dependency downloads cached when only source changes.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm fetch
COPY . .
# Install the clean source tree without workspace injection. Injection requires compiled workspace outputs,
# which do not exist yet in a fresh Docker build. After compilation, derive each deployment from the
# checked-in lockfile; legacy deploy re-resolves peers and can package incompatible runtime versions.
RUN pnpm --config.inject-workspace-packages=false install --prefer-offline --frozen-lockfile \
  && pnpm --filter "@noodle-borg/self-host..." --filter "@noodleseed/one..." run build \
  && pnpm --config.inject-workspace-packages=true --filter "@noodle-borg/self-host" deploy --prod /app/service-deploy \
  && pnpm --config.inject-workspace-packages=true --filter "@noodleseed/one" deploy --prod /app/cli-deploy \
  && pnpm --config.inject-workspace-packages=true --filter "@noodle-borg/github-builder-tooling" deploy --prod /app/builder-tooling \
  && find /app/service-deploy /app/cli-deploy /app/builder-tooling -type d -name '.ignored_*' -prune -exec rm -rf '{}' +

FROM node:24-slim AS service-runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/service-deploy ./
RUN mkdir -p /var/lib/noodle/assets && chown node:node /var/lib/noodle/assets
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA \
  org.opencontainers.image.created=$BUILD_TIME
ENV NOODLE_BUILD_SHA=$GIT_SHA NOODLE_BUILD_TIME=$BUILD_TIME
USER node
EXPOSE 8787
CMD ["node", "dist/main.js"]

FROM node:24-slim AS cli-runtime
WORKDIR /app
ENV NODE_ENV=production \
  NOODLE_BUILDER_VITE_ROOT=/app/builder-tooling
COPY --from=build /app/cli-deploy ./
COPY --from=build /app/builder-tooling ./builder-tooling
COPY --from=build --chown=node:node /app/examples /app/examples
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA \
  org.opencontainers.image.created=$BUILD_TIME
USER node
ENTRYPOINT ["node", "dist/bin.js"]
