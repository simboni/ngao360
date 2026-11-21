/**
 * Static checks of the production deployment files (Docker is not available to start them here).
 * Each guards a finding of the pilot security review:
 *  - the API and worker never receive the schema-owner or superuser database credentials;
 *  - the backup image installs its tools at build time (its network has no route out);
 *  - the SMS callback token is redacted from the reverse-proxy access log;
 *  - production env files, backups and load-test secrets never enter git or a build context.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** The lines of one top-level service block of a compose file (2-space indented YAML). */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) throw new Error(`service ${name} not found`);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (/^ {2}\S/.test(l) || /^\S/.test(l)) break;
    out.push(l);
  }
  return out.join('\n');
}

describe('production deployment configuration', () => {
  const compose = read('docker-compose.prod.yml');

  it('gives the API and worker only the runtime RLS role; the schema owner only to migrate and backup', () => {
    const anchor = compose.slice(compose.indexOf('x-api-env: &api-env'), compose.indexOf('\nservices:'));
    const urls = [...anchor.matchAll(/^\s+(?:APP_)?DATABASE_URL: (\S+)/gm)].map((m) => m[1]!);
    expect(urls).toHaveLength(2);
    for (const u of urls) expect(u).toMatch(/^postgresql:\/\/ngao_app:/);
    for (const svc of ['api', 'worker']) {
      const block = serviceBlock(compose, svc);
      expect(block).toContain('<<: *api-env');
      expect(block).not.toMatch(/DATABASE_URL|POSTGRES_PASSWORD|NGAO_OWNER_DB_PASSWORD/);
    }
    expect(serviceBlock(compose, 'migrate')).toMatch(/DATABASE_URL: postgresql:\/\/ngao_owner:/);
    // Nothing but the database container itself sees the superuser password.
    const superuserUses = compose.split('\n').filter((l) => l.includes('POSTGRES_PASSWORD'));
    expect(superuserUses).toEqual([expect.stringMatching(/^\s+POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD\}$/)]);
    expect(compose).not.toMatch(/postgresql:\/\/ngao:/);
    // The owner is created as a non-superuser by the init script.
    expect(read('infra/postgres/init-roles.sh')).toMatch(/CREATE ROLE ngao_owner LOGIN NOSUPERUSER/);
  });

  it('builds the backup image with its tools instead of installing them at run time', () => {
    const backup = serviceBlock(compose, 'backup');
    expect(backup).toMatch(/context: deploy\/backup/);
    expect(backup).not.toMatch(/apk add/);
    expect(backup).toMatch(/networks: \[backend\]/);
    expect(backup).toMatch(/PGUSER: ngao_owner/);
    expect(read('deploy/backup/Dockerfile')).toMatch(/^RUN apk add --no-cache bash coreutils/m);
  });

  it('redacts the SMS callback token from the access log and allow-lists the callback sources', () => {
    const caddy = read('deploy/caddy/Caddyfile');
    const rule = /request>uri regexp (\S+) (\S+)/.exec(caddy);
    expect(rule).not.toBeNull();
    const re = new RegExp(rule![1]!);
    const replacement = rule![2]!.replace('${1}', '$1');
    expect('/api/webhooks/sms/africastalking/secret-token-abcdef0123456789/delivery'.replace(re, replacement)).toBe(
      '/api/webhooks/sms/africastalking/REDACTED/delivery',
    );
    expect(caddy).toMatch(/not remote_ip \{\$AT_WEBHOOK_ALLOWED_IPS/);
    expect(caddy).toMatch(/request>headers>Cookie delete/);
  });

  it('keeps production env files, backups and load-test secrets out of git and out of build contexts', () => {
    const ignored = (p: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT });
        return true;
      } catch {
        return false;
      }
    };
    for (const p of ['.env.prod', 'deploy/prod.env', 'backups/ngao360-20261201/db.dump', '.load/totp-secrets.json']) expect(ignored(p)).toBe(true);
    for (const p of ['.env.example', '.env.docker.example', 'deploy/env.prod.example']) expect(ignored(p)).toBe(false);
    const dockerignore = read('.dockerignore').split('\n');
    for (const p of ['.env.*', 'backups', '.load', '**/*.dump']) expect(dockerignore).toContain(p);
  });
});
