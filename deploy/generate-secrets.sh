#!/usr/bin/env bash
# Create the production env file with fresh secrets, on the server itself (docs/DEPLOYMENT.md §5).
#
#   sudo deploy/generate-secrets.sh /etc/ngao360/.env.prod                 # production (app.ngao360.co.ke)
#   sudo deploy/generate-secrets.sh /etc/ngao360/.env.staging staging      # staging (staging.ngao360.co.ke)
#
# Copies deploy/env.prod.example when the target does not exist yet, then fills every EMPTY secret
# below with a new random value. Values already set are never changed, so it is safe to run again.
# Nothing is printed except variable NAMES. Provider keys (SMTP, Africa's Talking, captcha, VAPID) are
# left for you to fill in. Keep the file mode 600 and copy it into the secrets vault.
set -euo pipefail

target="${1:?usage: generate-secrets.sh <env file> [staging]}"
mode="${2:-production}"
here="$(cd "$(dirname "$0")" && pwd)"
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

umask 077
if [[ ! -e "$target" ]]; then
  install -d -m 700 "$(dirname "$target")"
  install -m 600 "$here/env.prod.example" "$target"
  echo "Created $target from deploy/env.prod.example"
fi
chmod 600 "$target"

set_if_empty() { # name value
  local name="$1" value="$2"
  if grep -qE "^${name}=$" "$target"; then
    # value is hex/base64 only, so it is safe inside the sed replacement with | as delimiter
    sed -i "s|^${name}=$|${name}=${value}|" "$target"
    echo "  set ${name}"
  fi
}
replace_value() { # name value (domain lines for staging)
  sed -i "s|^$1=.*$|$1=$2|" "$target"
  echo "  set $1"
}

# Passwords that end up inside connection URLs: hex only (no / + = to escape).
for v in POSTGRES_PASSWORD NGAO_OWNER_DB_PASSWORD NGAO_APP_DB_PASSWORD REDIS_PASSWORD MINIO_ROOT_PASSWORD \
         S3_APP_SECRET_ACCESS_KEY S3_BACKUP_SECRET_ACCESS_KEY AFRICASTALKING_DLR_TOKEN; do
  set_if_empty "$v" "$(openssl rand -hex 24)"
done
for v in JWT_ACCESS_SECRET JWT_REFRESH_SECRET MESSAGING_HASH_KEY; do
  set_if_empty "$v" "$(openssl rand -base64 48 | tr -d '\n')"
done
for v in MFA_ENCRYPTION_KEY MESSAGING_ENCRYPTION_KEY AGENT_DATA_KEY; do
  set_if_empty "$v" "$(openssl rand -base64 32 | tr -d '\n')"
done

if [[ "$mode" == "staging" ]]; then
  replace_value NGAO_DOMAIN staging.ngao360.co.ke
  replace_value NGAO_REDIRECT_DOMAINS ""
  replace_value NGAO_WEBAUTHN_RP_ID staging.ngao360.co.ke
fi

echo "Done. Still to fill by hand (provider accounts): SMTP_*, AFRICASTALKING_*, CAPTCHA_*, VAPID_*,"
echo "and set the matching *_PROVIDER lines. Store a copy of $target in the secrets vault."
