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

On a Linux host with Docker Engine and the compose plugin, in Kenya or with a copy held in Kenya
(docs/RESEARCH.md, data protection), with ports 80/443 open and 22 limited to administrators:

1. Clone the repository at the release tag into `/srv/ngao360`.
2. `install -m 600 deploy/env.prod.example /etc/ngao360/.env.prod` and fill every value.
   The domain lines are already set for production:
   ```
   NGAO_DOMAIN=app.ngao360.co.ke
   NGAO_REDIRECT_DOMAINS=ngao360.co.ke, www.ngao360.co.ke
   NGAO_WEBAUTHN_RP_ID=ngao360.co.ke
   ```
   For staging use `NGAO_DOMAIN=staging.ngao360.co.ke`, `NGAO_REDIRECT_DOMAINS=` (empty) and
   `NGAO_WEBAUTHN_RP_ID=staging.ngao360.co.ke`, with its own secrets.
3. Generate secrets as the comments in the env file say (`openssl rand -base64 48` / `32`) and store a
   copy in the secrets vault (docs/RUNBOOKS.md, key custody).
4. Start the stack, run migrations and create the first organisation, following
   `docs/RUNBOOKS.md` → Deploy. The first owner then completes **Workspace setup** (`/setup`) and the
   **Onboarding checklist** (`/onboarding`).
5. Check: `https://app.ngao360.co.ke/api/health` answers, `https://ngao360.co.ke/anything` redirects
   to `https://app.ngao360.co.ke/anything`, Settings → Integrations shows every provider configured,
   a test invitation arrives in an inbox (not spam), and a passkey can be registered and used.
6. Run the restore drill on the host (`docs/OPERATIONS.md`) and record it in the onboarding checklist.

## 6. Status of this configuration

- The compose file, Caddyfile and env template carry the domain settings above; the passkey-domain
  start-up check has unit tests.
- **Not yet tried on a real host:** no Docker image has been built and the stack has not been started
  (no Docker daemon in the build environment), and the Caddyfile has not been loaded by a Caddy
  binary. The first staging deployment is the test of this guide.
