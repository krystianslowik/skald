# syntax=docker/dockerfile:1.7
#
# skald-bridge: the Skald bridge plugin (SkaldBridge.dll, under 100 KB) and the
# script that installs it into the community valheim-server image's BepInEx
# plugin directory. Used as an initContainer of the game pod (see
# deploy/kubernetes/bridge). Holds no game files: the build stage fetches the
# reference DLLs anonymously (bridge/build.sh), compiles, and only the plugin
# is copied into the busybox image.
#   docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/krystianslowik/skald-bridge:dev bridge
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0 AS build
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY build.sh ./
COPY plugin/ plugin/
RUN sh build.sh && test -s out/SkaldBridge.dll

FROM busybox:1.37
ARG VERSION=dev
LABEL org.opencontainers.image.title=skald-bridge \
      org.opencontainers.image.description="Skald bridge: a server-side BepInEx plugin with live admin commands for the Skald agent" \
      org.opencontainers.image.licenses=Apache-2.0 \
      org.opencontainers.image.version=$VERSION
COPY --from=build /src/out/SkaldBridge.dll /skald/SkaldBridge.dll
COPY --chmod=0755 install.sh /skald/install.sh
CMD ["/skald/install.sh"]
