# syntax=docker/dockerfile:1.7
#
# skald-icons: builds the item icon sheet from the operator's own Valheim
# server install (mounted read-only). Contains no game files.
#   docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/krystianslowik/skald-icons:dev icons
#
# Wheels are built in a full Python image: not every package publishes a
# wheel for every architecture (UnityPy has none for linux/arm64), and the
# runtime image carries no compiler.
FROM python:3.13 AS wheels
WORKDIR /src
COPY requirements.txt .
# --no-deps: UnityPy's fmod_toolkit dependency bundles the proprietary libfmod;
# it is left out and stubbed (audio is never read). Everything installed is
# MIT, BSD or Apache licensed; see THIRD_PARTY_NOTICES.md.
RUN pip wheel --no-cache-dir --no-deps -r requirements.txt -w /wheels

FROM python:3.13-slim
ARG VERSION=dev
LABEL org.opencontainers.image.title=skald-icons \
      org.opencontainers.image.description="Item icon sheet for Skald, from the operator's own Valheim server files" \
      org.opencontainers.image.licenses=Apache-2.0 \
      org.opencontainers.image.version=$VERSION
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN --mount=type=bind,from=wheels,source=/wheels,target=/wheels \
    pip install --no-cache-dir --no-deps --no-index /wheels/*.whl \
 && python -c "import sys, types; sys.modules['fmod_toolkit'] = types.ModuleType('fmod_toolkit'); import lz4.block, PIL.WebPImagePlugin, texture2ddecoder, UnityPy" \
 && python -m compileall -q /usr/local/lib/python3.13/site-packages
COPY extract.py THIRD_PARTY_NOTICES.md ./
RUN python -m compileall -q /app
USER 65532:65532
ENTRYPOINT ["python", "-I", "/app/extract.py"]
CMD ["--game", "/opt/valheim", "--out", "/icons", "--every", "600", "--nice", "19"]
