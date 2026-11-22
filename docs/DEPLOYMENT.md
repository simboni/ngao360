# Deploying NGAO360 on ngao360.co.ke

The product owner chose **ngao360.co.ke** as the production domain (21 Nov 2026). This guide covers the
domain plan, DNS records, e-mail authentication and the first deployment. Day-2 procedures (rollback,
key rotation, restore, election day, breach response) are in `docs/RUNBOOKS.md`; capacity and the
restore drill are in `docs/OPERATIONS.md`.

## 1. Host names

| Host | Purpose | Served by |
| --- | --- | --- |
| `app.ngao360.co.ke` | The application: staff web app, API under `/api`, citizen portal under `/p/<organisation>` | Caddy → web and API (`NGAO_DOMAIN`) |
| `ngao360.co.ke`, `www.ngao360.co.ke` | Permanent redirect to `app.ngao360.co.ke`, path kept, so `https://ngao360.co.ke/p/bungoma-governor` reaches the portal | Caddy (`NGAO_REDIRECT_DOMAINS`) |
| `staging.ngao360.co.ke` | Staging copy for rehearsals and the office dry run, synthetic data only | Separate host and env file |
| `notify.ngao360.co.ke` | Sending domain for e-mail (`no-reply@notify.ngao360.co.ke`), kept apart from the main domain's reputation | Your SMTP provider |

Why the app lives on `app.` rather than the bare domain: the bare domain stays free for a product
site later, and moving the app never breaks passkeys (next point).

**Passkeys** are bound to `NGAO_WEBAUTHN_RP_ID=ngao360.co.ke`, the registrable domain. They then keep
working for `app.ngao360.co.ke` and any future subdomain of it. The API refuses to start if the
passkey domain is not the web host or a parent of it. Staging uses
`NGAO_WEBAUTHN_RP_ID=staging.ngao360.co.ke` so staging passkeys are never offered on production.
Only point subdomains of `ngao360.co.ke` at hosts you control.

The organisation-per-subdomain pattern (e.g. `bungoma.ngao360.co.ke`) is not used: organisations are
chosen by their code at sign-in and by the path on the public portal.

## 2. DNS records

Create these at the `.co.ke` registrar's DNS (or the DNS provider the domain is delegated to).
Replace `203.0.113.10` / `2001:db8::10` with the production server's addresses.

| Name | Type | Value | Notes |
| --- | --- | --- | --- |
| `app` | A | `203.0.113.10` | Production server |
| `app` | AAAA | `2001:db8::10` | Only if the server has IPv6 |
| `@` | A | `203.0.113.10` | Redirect only |
| `www` | CNAME | `app.ngao360.co.ke.` | Redirect only |
| `staging` | A | staging server address | |
| `@` | CAA | `0 issue "letsencrypt.org"` | Only Let's Encrypt may issue certificates (Caddy uses it) |
| `@` | CAA | `0 iodef "mailto:security@ngao360.co.ke"` | Where CAs report problems |

Keep the TTL at 300 s until the first deployment is stable, then raise it to 3600 s.

Caddy obtains and renews TLS certificates automatically once the A/AAAA records resolve and ports 80
and 443 reach the server. HSTS is sent for one year with `includeSubDomains`; do **not** submit the
domain to the HSTS preload list until every subdomain, including staging and mail web interfaces,
serves HTTPS.

## 3. E-mail authentication (`notify.ngao360.co.ke`)

Invitations, recovery links, verification codes and citizen acknowledgements are sent by e-mail.
Without these records most of them will land in spam.

| Name | Type | Value |
| --- | --- | --- |
| `notify` | TXT | SPF from your SMTP provider, e.g. `v=spf1 include:<provider-spf-domain> -all` |
| `<selector>._domainkey.notify` | TXT or CNAME | DKIM key given by your SMTP provider |
| `_dmarc.notify` | TXT | `v=DMARC1; p=quarantine; rua=mailto:dmarc@ngao360.co.ke; adkim=s; aspf=s` |
| `_dmarc` | TXT | `v=DMARC1; p=reject; rua=mailto:dmarc@ngao360.co.ke` (the bare domain sends nothing) |
| `@` | TXT | `v=spf1 -all` (until the bare domain sends mail) |

Start `notify` at `p=none` for a week if you want to watch the DMARC reports first, then move to
`quarantine`. Set in the env file:

```
EMAIL_PROVIDER=smtp
EMAIL_FROM_ADDRESS=no-reply@notify.ngao360.co.ke
EMAIL_FROM_NAME=NGAO360
SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD from the provider
```

## 4. Other providers tied to the domain

- **Africa's Talking:** register the sender ID (e.g. `NGAO360`) early; approval takes about 2–14
  business days. Set the delivery-report callback to
  `https://app.ngao360.co.ke/api/webhooks/sms/africastalking/<AFRICASTALKING_DLR_TOKEN>` and restrict
  `AT_WEBHOOK_ALLOWED_IPS` to the vendor's published addresses.
- **Cloudflare Turnstile / hCaptcha:** add `app.ngao360.co.ke` (and `staging.ngao360.co.ke` on a
  separate site key) as allowed host names.
- **Web push:** `VAPID_SUBJECT=mailto:security@ngao360.co.ke`.

## 5. First deployment (production or staging)

A Linux server (Ubuntu 24.04 LTS assumed) with at least 4 vCPU, 8 GB RAM and 80 GB disk free for
staging or a county pilot; production on its own server (docs/OPERATIONS.md for election-night sizing),
in Kenya or with a copy of the data held in Kenya (docs/RESEARCH.md, data protection). Run as an
administrator with `sudo`.

**1. Prepare the server** (once)

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git openssl ufw
curl -fsSL https://get.docker.com | sudo sh          # Docker Engine and the compose plugin
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw --force enable
```

Point DNS at the server first (§2): `app` (or `staging`) must resolve to it before step 4, or Caddy
cannot obtain a certificate.

**2. Get the code**

```bash
sudo git clone https://github.com/simboni/ngao360.git /srv/ngao360
cd /srv/ngao360 && sudo git checkout <release tag or main>
```

(If the repository is made private later, use a read-only deploy key on the server.)

**3. Create the env file with fresh secrets** (generated on the server, never printed)

```bash
sudo deploy/generate-secrets.sh /etc/ngao360/.env.prod            # production
sudo deploy/generate-secrets.sh /etc/ngao360/.env.prod staging    # or: staging.ngao360.co.ke
```

Then open the file (`sudo nano /etc/ngao360/.env.prod`) and add the provider accounts you have (SMTP,
Africa's Talking, captcha, VAPID) with their `*_PROVIDER` lines. Without SMTP, invitation links are shown
once on screen instead of e-mailed. Copy the file into the secrets vault (docs/RUNBOOKS.md, key custody):
losing `AGENT_DATA_KEY` or `MFA_ENCRYPTION_KEY` makes encrypted data unreadable.

**4. Build and start**

```bash
cd /srv/ngao360
C="sudo docker compose -f docker-compose.prod.yml --env-file /etc/ngao360/.env.prod"
$C build                 # first build takes several minutes
$C up -d                 # runs migrations first; API, worker and web start once they succeed
$C ps                    # every service healthy, migrate and minio-init exited 0
```

**4a. On a shared server whose proxy already owns ports 80/443**

If another reverse proxy (for example an `edge-caddy` container serving other sites) already listens on
80/443, NGAO360 must not publish those ports. Use the override file, which removes NGAO360's public ports
and joins its Caddy to the existing proxy's Docker network instead:

```bash
docker inspect edge-caddy --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}'
# put that network name in the env file:  NGAO_EDGE_NETWORK=<name>
C="docker compose -f docker-compose.prod.yml -f deploy/compose.behind-proxy.yml --env-file /etc/ngao360/.env.prod"
$C up -d --build
```

Then add one site to the existing proxy's Caddyfile and reload it (other sites are untouched):

```
staging.ngao360.co.ke {
	reverse_proxy ngao360:80
}
```

The existing proxy obtains the certificate; NGAO360 trusts its `X-Forwarded-For` so rate limits see
the real visitor (TRUST_PROXY_HOPS=2). Every NGAO360 service has a memory and CPU cap
(`NGAO_*_MEMORY`, smaller for staging), its databases and scanner stay on its own internal network, and
its containers, volumes and networks are all named `ngao360-prod_*`, so no other stack is touched.
Docker builds share the server's CPU while they run; build at a quiet time.

**5. Create the first account** (the platform operator; once per install)

```bash
$C run --rm migrate node dist/cli/bootstrap-operator.js --email you@ngao360.co.ke --name "Your Name"
```

It prints a single-use link (shown only then; run it again before it is used to get a fresh one). Open it,
set your password, then sign in with organisation code `platform` and enrol an authenticator app or a
passkey. The command refuses once an active operator exists: invite everyone else from the app.

**6. Create the first organisation**

Signed in as the operator, open **Workspace setup** (`/setup`) to create the organisation (for example the
Bungoma Governor's office) and invite its first administrators. They complete the **Onboarding
checklist** (`/onboarding`).

**7. Check**

- `https://app.ngao360.co.ke/api/health` reports database, storage and redis `up`;
- `https://ngao360.co.ke/anything` redirects to `https://app.ngao360.co.ke/anything` (production);
- Settings → Integrations shows the providers you configured and no missing variables;
- a test invitation arrives in an inbox, not spam (once SMTP is set);
- a passkey can be registered and used;
- run the restore drill on the server (docs/OPERATIONS.md) and record it in the onboarding checklist;
- schedule the nightly backup (`$C --profile ops run --rm backup` from a systemd timer or cron) and copy
  backups off the server.

Updates after the first deployment follow docs/RUNBOOKS.md → Deploy.

## 6. Status of this configuration

- **Object storage image (open, must be settled before the next deployment):** the stacks use the
  `minio/minio` and `minio/mc` images for the Object Lock store of originals. A local `docker compose`
  pull of `minio/minio` was refused on 22 Nov 2026 ("pull access denied"); MinIO appears to have stopped
  publishing free images on Docker Hub. Options: build MinIO from source into our own image, use another
  S3-compatible store that supports Object Lock (e.g. Ceph RGW), or a hosted S3 service with Object
  Lock (for example AWS S3, Backblaze B2 or Wasabi; check data-location rules). The application only
  needs the S3 API with Object Lock, so this is a deployment choice, not a code change.
- The compose file, Caddyfile and env template carry the domain settings above; the passkey-domain
  start-up check has unit tests.
- `deploy/generate-secrets.sh` was run on a scratch file (secrets filled, existing values kept, mode 600).
- `dist/cli/bootstrap-operator.js` has integration tests against Postgres and was run against the
  development database (refused, as designed, because an active operator exists there).
- **Not yet tried on a real host:** no Docker image has been built and the stack has not been started
  (no Docker daemon in the build environment), and the Caddyfile has not been loaded by a Caddy
  binary. The first staging deployment is the test of this guide.
