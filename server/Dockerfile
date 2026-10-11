# syntax=docker/dockerfile:1.28
#
# skald-web: one image holding the Bun-compiled server and the Vite-built SPA.
#   1. web-build     -> web/dist (static files, built once on the build host)
#   2. server-build  -> single Bun binary, cross-compiled for the target arch
#   3. final         -> oven/bun:1.4-alpine runtime (the binary needs its musl libstdc++)
#
# Build context is the REPOSITORY ROOT:
#   docker buildx build --platform linux/amd64,linux/arm64 -f server/Dockerfile \
#     -t ghcr.io/krystianslowik/skald-web:dev .

FROM --platform=$BUILDPLATFORM node:25-alpine AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --silent
COPY web/ ./
# The web app imports the shared wire types from ../server/src via the `@server` alias.
COPY server/src /src/server/src
RUN npm run build

FROM --platform=$BUILDPLATFORM oven/bun:1.4-alpine AS server-build
ARG TARGETARCH
WORKDIR /server
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY server/tsconfig.json ./
COPY server/src ./src
RUN case "$TARGETARCH" in \
      amd64) target=bun-linux-x64-musl ;; \
      arm64) target=bun-linux-arm64-musl ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && bun build --compile --minify --target="$target" src/server.ts --outfile /out/skald-web

FROM oven/bun:1.4-alpine
RUN addgroup -g 65532 -S nonroot && adduser -u 65532 -S nonroot -G nonroot \
 && mkdir -p /data && chown nonroot:nonroot /data
# The server resolves WEB_ROOT (default ../web/dist) against its CWD.
WORKDIR /app/bin
COPY --from=server-build /out/skald-web /app/bin/skald-web
COPY --from=web-build /src/web/dist /app/web/dist
USER nonroot:nonroot
ENV DB_PATH=/data/skald.db
EXPOSE 8080
ENTRYPOINT ["/app/bin/skald-web"]
