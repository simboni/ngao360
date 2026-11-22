# syntax=docker/dockerfile:1
# MinIO server and the mc client built from source at pinned releases.
# MinIO stopped publishing free images on Docker Hub (minio/minio could not be pulled on 22 Nov 2026),
# so NGAO360 builds its own. Both are AGPL-3.0 and their source stays public. The same image serves
# the `minio` service (server) and the one-shot `minio-init` service (mc + /bin/sh).
ARG GO_IMAGE=golang:1.24-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim
ARG MINIO_RELEASE=RELEASE.2025-04-22T22-12-26Z
ARG MC_RELEASE=RELEASE.2025-04-16T18-13-26Z

FROM ${GO_IMAGE} AS build
ARG MINIO_RELEASE
ARG MC_RELEASE
ENV CGO_ENABLED=0 GOFLAGS=-trimpath
WORKDIR /src
RUN git clone --depth 1 --branch "${MINIO_RELEASE}" https://github.com/minio/minio.git minio \
  && git clone --depth 1 --branch "${MC_RELEASE}" https://github.com/minio/mc.git mc
# cmd.Version is RFC 3339 (2025-04-22T22:12:26Z); the release tag uses dashes in the time part.
RUN --mount=type=cache,target=/root/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
  ver="$(echo "${MINIO_RELEASE#RELEASE.}" | sed -E 's/T([0-9]{2})-([0-9]{2})-([0-9]{2})Z/T\1:\2:\3Z/')" \
  && cd minio && go build -ldflags "-s -w -X github.com/minio/minio/cmd.Version=${ver} -X github.com/minio/minio/cmd.ReleaseTag=${MINIO_RELEASE}" -o /out/minio . \
  && cd ../mc && go build -ldflags "-s -w" -o /out/mc .

FROM ${RUNTIME_IMAGE}
# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/minio /out/mc /usr/local/bin/
EXPOSE 9000 9001
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
