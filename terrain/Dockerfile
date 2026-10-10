# syntax=docker/dockerfile:1.7
#
# skald-terrain: Skald's terrain sampler plugin and the two scripts that run
# it inside the community valheim-server image. Holds no game files; the
# plugin binds to the game by reflection and is compiled against BepInEx and
# Unity reference assemblies only. Used as an initContainer that copies
# /skald into a volume shared with the game container (see
# deploy/kubernetes/terrain).
#   docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/krystianslowik/skald-terrain:dev terrain
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY plugin/ .
RUN dotnet build -c Release -o /out && test -s /out/SkaldTerrain.dll

FROM busybox:1.37
ARG VERSION=dev
LABEL org.opencontainers.image.title=skald-terrain \
      org.opencontainers.image.description="Skald terrain sampler: a BepInEx plugin run inside the operator's own Valheim server image" \
      org.opencontainers.image.licenses=Apache-2.0 \
      org.opencontainers.image.version=$VERSION
COPY --from=build /out/SkaldTerrain.dll /skald/SkaldTerrain.dll
COPY --chmod=0755 run.sh /skald/run.sh
COPY --chmod=0644 hook.sh /skald/hook.sh
# Copies the files into the volume mounted at /dest and exits.
CMD ["sh", "-c", "cp -f /skald/SkaldTerrain.dll /skald/run.sh /skald/hook.sh /dest/ && chmod 0755 /dest/run.sh && ls -l /dest"]
