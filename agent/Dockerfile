# syntax=docker/dockerfile:1.28
#
# skald-agent: the Go sidecar that runs next to the Valheim server.
# Pure Go, stdlib only, so it cross-compiles on the build host for every
# target platform:
#   docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/krystianslowik/skald-agent:dev .
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS build
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
# Stdlib only: there is no go.sum to copy.
COPY go.mod ./
COPY . .
# VERSION is the release (2026.10.0); local builds report "dev".
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=$VERSION" -o /out/skald-agent ./cmd/agent

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/skald-agent /skald-agent
USER nonroot:nonroot
EXPOSE 8080 9464
ENTRYPOINT ["/skald-agent"]
