# Backup runner for docker-compose.prod.yml (`backup` service, profile "ops").
# Everything scripts/ops/backup.sh needs is installed at BUILD time: the service runs on the
# internal backend network, which has no route to package mirrors. Same Postgres major version
# as the server, so pg_dump matches.
FROM postgres:16.10-alpine
# hadolint ignore=DL3018
RUN apk add --no-cache bash coreutils
ENTRYPOINT ["bash", "/ops/backup.sh"]
