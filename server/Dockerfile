# syntax=docker/dockerfile:1.28
#
# skald-web: one image holding the Bun-compiled server and the Vite-built SPA.
#   1. web-build     -> web/dist (static files, built once on the build host)
#   2. server-build  -> single Bun binary, cross-compiled for the target arch
#   3. final         -> plain alpine plus libstdc++/libgcc, the binary's only
#                       dependencies (it embeds Bun, so no second runtime ships)
#
# Bun is pinned to one version, the same as bun-version in .github/workflows/ci.yaml.
# Keep 1.4.3 or later: older Bun sent broken responses when gzip and
# uncompressed bodies were mixed.
#
# Build context is the REPOSITORY ROOT:
#   docker buildx build --platform linux/amd64,linux/arm64 -f server/Dockerfile \
#     -t ghcr.io/krystianslowik/skald-web:dev .

FROM --platform=$BUILDPLATFORM node:26-alpine AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --silent
COPY web/ ./
# The web app imports the shared wire types from ../server/src via the `@server` alias.
COPY server/src /src/server/src
RUN npm run build

FROM --platform=$BUILDPLATFORM oven/bun:1.4.3-alpine AS server-build
ARG TARGETARCH
# The release (2026.10.0), compiled into the binary; local builds report "dev".
ARG VERSION=dev
WORKDIR /server
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server/tsconfig.json ./
COPY server/src ./src
# SKALD_NO_MOCK leaves the mock agent (`bun run dev`) out of the binary.
RUN case "$TARGETARCH" in \
      amd64) target=bun-linux-x64-musl ;; \
      arm64) target=bun-linux-arm64-musl ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && bun build --compile --minify --target="$target" --define "process.env.SKALD_VERSION=\"$VERSION\"" --define 'process.env.SKALD_NO_MOCK="1"' src/server.ts --outfile /out/skald-web

# The same Alpine release as the oven/bun image above, for the same musl.
FROM alpine:3.24
RUN apk add --no-cache libstdc++ libgcc \
 && addgroup -g 65532 -S nonroot && adduser -u 65532 -S nonroot -G nonroot \
 && mkdir -p /data && chown nonroot:nonroot /data
# The server resolves WEB_ROOT (default ../web/dist) against its CWD.
WORKDIR /app/bin
COPY --from=server-build /out/skald-web /app/bin/skald-web
COPY --from=web-build /src/web/dist /app/web/dist
USER nonroot:nonroot
ENV DB_PATH=/data/skald.db
EXPOSE 8080
ENTRYPOINT ["/app/bin/skald-web"]
