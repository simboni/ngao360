#!/usr/bin/env node
/*
 * NGAO360 HTTP load driver (no dependencies; Node 22 fetch with keep-alive).
 *
 * Drives a running API (normally the load stack from scripts/load/run-load.sh) through the election-day
 * hot paths with a fixed number of concurrent virtual users per scenario, then prints and writes
 * p50 / p95 / p99 latency, throughput and error rates:
 *
 *   tally-intake       POST /tally/submissions (multipart PNG, unique bytes, new idempotency key)   clerk
 *   verify-queue       GET  /tally/submissions?view=awaiting_me (first page)                        verifier
 *   aggregate          GET  /tally/results/live (55k-station denominator)                           supervisor
 *   warroom-overview   GET  /warroom/overview                                                       commander
 *   warroom-stations   GET  /warroom/stations?attentionOnly=true (first page)                      commander
 *   field-sync         POST /field/sync (5 opening-of-polls reports per batch)     one load agent per VU
 *
 * Environment:
 *   LOAD_API            API base(s), comma-separated, default http://127.0.0.1:4100/api
 *   LOAD_CONTEXT        JSON file with ids (written by run-load.sh from the load database)
 *   LOAD_PASSWORD       demo password (default Demo-Password-2027)
 *   LOAD_TOTP_SECRET    base32 TOTP secret of the pre-enrolled demo users (development seed only)
 *   LOAD_DURATION_S     seconds per scenario (default 30)
 *   LOAD_SCENARIOS      comma list (default all) ; LOAD_CONCURRENCY_<NAME> per scenario override
 *   LOAD_OUT            write the JSON results here
 * All data is synthetic; never point this at a real deployment.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// One or more API base URLs (comma-separated); virtual users are spread round-robin across them.
const APIS = (process.env.LOAD_API ?? 'http://127.0.0.1:4100/api').split(',').map((s) => s.trim()).filter(Boolean);
const API = APIS[0];
const ctx = JSON.parse(readFileSync(process.env.LOAD_CONTEXT ?? 'load-context.json', 'utf8'));
const PASSWORD = process.env.LOAD_PASSWORD ?? 'Demo-Password-2027';
const TOTP_SECRET = process.env.LOAD_TOTP_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const DURATION_MS = Number(process.env.LOAD_DURATION_S ?? 30) * 1000;
const CSRF = { 'x-ngao-client': 'web' };

/* --------------------------------- TOTP ---------------------------------- */
function base32(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, step) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/* -------------------------------- Sessions -------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cookiesFrom(res, jar = new Map()) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return jar;
}
const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

const usedSteps = new Set();
// TOTP secrets of factors this driver enrolled (synthetic load accounts only), kept between runs.
const SECRETS_FILE = process.env.LOAD_SECRETS_FILE ?? '.load/totp-secrets.json';
const enrolledSecrets = new Map(Object.entries((() => { try { return JSON.parse(readFileSync(SECRETS_FILE, 'utf8')); } catch { return {}; } })()));
async function login(email) {
  console.error(`signing in ${email}`);
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CSRF },
    body: JSON.stringify({ tenantSlug: ctx.tenantSlug, email, password: PASSWORD }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${body.code ?? ''}`);
  const jar = cookiesFrom(res);
  if (body.status === 'AUTHENTICATED') return jar;
  if (body.status === 'MFA_ENROLMENT_REQUIRED') {
    // First sign-in of a privileged load user: enrol a TOTP factor with the returned secret.
    const post = (path, payload) =>
      fetch(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...CSRF }, body: JSON.stringify(payload) });
    const start = await post('/auth/mfa/enrol/start', { challengeToken: body.challengeToken, label: 'Load test (synthetic)' });
    const s = await start.json();
    if (!start.ok) throw new Error(`enrol ${email}: ${start.status}`);
    const step = Math.floor(Date.now() / 30_000);
    usedSteps.add(`${email}:${step}`);
    enrolledSecrets.set(email, s.secret);
    writeFileSync(SECRETS_FILE, JSON.stringify(Object.fromEntries(enrolledSecrets)), { mode: 0o600 });
    const confirm = await post('/auth/mfa/enrol/confirm', { challengeToken: body.challengeToken, factorId: s.factorId, code: totp(s.secret, step) });
    if (!confirm.ok) throw new Error(`enrol confirm ${email}: ${confirm.status}`);
    return cookiesFrom(confirm, jar);
  }
  if (body.status !== 'MFA_REQUIRED') throw new Error(`login ${email}: ${body.status}`);
  const secret = enrolledSecrets.get(email) ?? TOTP_SECRET;
  // A TOTP step is accepted once per user; wait for a fresh step if this user already used it.
  for (;;) {
    const step = Math.floor(Date.now() / 30_000);
    if (!usedSteps.has(`${email}:${step}`)) {
      usedSteps.add(`${email}:${step}`);
      const v = await fetch(`${API}/auth/mfa/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...CSRF },
        body: JSON.stringify({ challengeToken: body.challengeToken, code: totp(secret, step) }),
      });
      if (v.ok) return cookiesFrom(v, jar);
      if (v.status !== 401 && v.status !== 400) throw new Error(`mfa ${email}: ${v.status}`);
      console.error(`mfa ${email}: ${v.status} at step ${step}, retrying on the next step`);
    }
    await sleep(2000);
  }
}

/* ------------------------------ Request makers ----------------------------- */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A valid 320x240 grey PNG whose pixels carry random noise, so every upload has a new SHA-256 (~60 KB). */
function uniquePng() {
  const w = 320, h = 240;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w + 1) * h);
  const noise = randomBytes(raw.length);
  for (let y = 0; y < h; y++) { raw[y * (w + 1)] = 0; noise.copy(raw, y * (w + 1) + 1, y * (w + 1) + 1, (y + 1) * (w + 1)); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let stationCursor = 0;
const scenarios = {
  'tally-intake': {
    user: 'clerk@demo.example.org',
    concurrency: 8,
    request() {
      const stationId = ctx.intakeStationIds[stationCursor++ % ctx.intakeStationIds.length];
      const form = new FormData();
      form.set('file', new Blob([uniquePng()], { type: 'image/png' }), 'form-37a.png');
      form.set('metadata', JSON.stringify({
        electionCycleId: ctx.cycleId, contestId: ctx.contestId, formTemplateId: ctx.templateId, pollingStationId: stationId,
        sourceType: 'CLERK_UPLOAD', idempotencyKey: randomUUID(), imageQuality: 'GOOD', pageCount: 1,
      }));
      return { method: 'POST', path: '/tally/submissions', body: form };
    },
  },
  'verify-queue': {
    user: 'verifier@demo.example.org',
    concurrency: 16,
    request: () => ({ method: 'GET', path: `/tally/submissions?view=awaiting_me&page=1&pageSize=25` }),
  },
  aggregate: {
    user: 'supervisor@demo.example.org',
    concurrency: 8,
    request: () => ({ method: 'GET', path: `/tally/results/live?electionCycleId=${ctx.cycleId}&contestId=${ctx.contestId}` }),
  },
  'warroom-overview': {
    user: 'commander@demo.example.org',
    concurrency: 16,
    request: () => ({ method: 'GET', path: `/warroom/overview?electionCycleId=${ctx.cycleId}` }),
  },
  'warroom-stations': {
    user: 'commander@demo.example.org',
    concurrency: 16,
    request: () => ({ method: 'GET', path: `/warroom/stations?electionCycleId=${ctx.cycleId}&attentionOnly=true&page=1&pageSize=50` }),
  },
  'field-sync': {
    user: 'agent1@demo.example.org',
    concurrency: 16,
    // Each virtual user is a different polling agent reporting for its own station (seed-load.sql).
    vuUser: (n) => (ctx.loadAgents?.length ? ctx.loadAgents[n % ctx.loadAgents.length] : null),
    request(vu) {
      const now = new Date();
      const items = Array.from({ length: 5 }, () => {
        const key = randomUUID();
        const deviceId = `load-device-${key.slice(0, 8)}`;
        return {
          idempotencyKey: key, deviceId, clientCreatedAt: now.toISOString(), kind: 'FIELD_REPORT',
          payload: {
            clientIdempotencyKey: key, deviceId, clientCreatedAt: now.toISOString(), submittedOffline: true,
            templateId: ctx.openingTemplateId, electionCycleId: ctx.cycleId, location: { pollingStationCode: vu?.code ?? ctx.agentStationCode },
            eventAt: now.toISOString(), answers: ctx.openingAnswers,
          },
        };
      });
      return { method: 'POST', path: '/field/sync', json: { items } };
    },
    check: (body) => (body.results ?? []).every((r) => r.outcome === 'ACCEPTED'),
  },
};

/* --------------------------------- Runner --------------------------------- */
function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function runScenario(name, def, jar) {
  const concurrency = Number(process.env[`LOAD_CONCURRENCY_${name.toUpperCase().replace(/-/g, '_')}`] ?? def.concurrency);
  for (let n = 0; n < concurrency; n++) {
    const who = def.vuUser?.(n);
    if (who) await sessionFor(who.email);
  }
  const lat = [];
  const statuses = {};
  let errors = 0, semanticErrors = 0, bytes = 0;
  const start = performance.now();
  const until = start + DURATION_MS;
  async function vu(n) {
    const base = APIS[n % APIS.length];
    const who = def.vuUser?.(n) ?? null;
    const vuJar = who ? await sessionFor(who.email) : jar;
    while (performance.now() < until) {
      const r = def.request(who);
      const headers = { cookie: cookieHeader(vuJar), ...CSRF };
      let body = r.body;
      if (r.json) { headers['content-type'] = 'application/json'; body = JSON.stringify(r.json); }
      const t0 = performance.now();
      try {
        const res = await fetch(`${base}${r.path}`, { method: r.method, headers, body });
        const text = await res.text();
        const ms = performance.now() - t0;
        lat.push(ms);
        bytes += text.length;
        statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        if (res.status >= 400) errors++;
        else if (def.check && !def.check(JSON.parse(text))) semanticErrors++;
      } catch (err) {
        lat.push(performance.now() - t0);
        statuses[err.cause?.code ?? 'NETWORK'] = (statuses[err.cause?.code ?? 'NETWORK'] ?? 0) + 1;
        errors++;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, n) => vu(n)));
  const elapsed = (performance.now() - start) / 1000;
  lat.sort((a, b) => a - b);
  const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
  return {
    scenario: name, concurrency, durationS: Math.round(elapsed * 10) / 10, requests: lat.length,
    rps: Math.round((lat.length / elapsed) * 10) / 10,
    p50: r1(pct(lat, 50)), p95: r1(pct(lat, 95)), p99: r1(pct(lat, 99)), max: r1(lat.at(-1) ?? null),
    errorRate: lat.length ? Math.round(((errors + semanticErrors) / lat.length) * 10000) / 100 : null,
    statuses, semanticErrors, avgBytes: lat.length ? Math.round(bytes / lat.length) : 0,
  };
}

const sessions = new Map();
async function sessionFor(email) {
  if (!sessions.has(email)) sessions.set(email, await login(email));
  return sessions.get(email);
}
const wanted = (process.env.LOAD_SCENARIOS ?? Object.keys(scenarios).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const results = [];
if (process.env.LOAD_MIX === '1') {
  // Mixed run: every scenario at once, as on election night (intake and sync write while dashboards read).
  for (const name of wanted) if (!sessions.has(scenarios[name].user)) sessions.set(scenarios[name].user, await login(scenarios[name].user));
  const mixed = await Promise.all(wanted.map((name) => runScenario(name, scenarios[name], sessions.get(scenarios[name].user))));
  for (const r of mixed) {
    r.scenario = `${r.scenario} (mixed)`;
    results.push(r);
    console.log(`${r.scenario.padEnd(26)} c=${String(r.concurrency).padStart(3)} n=${String(r.requests).padStart(6)} rps=${String(r.rps).padStart(7)} p50=${r.p50}ms p95=${r.p95}ms p99=${r.p99}ms max=${r.max}ms err=${r.errorRate}% ${JSON.stringify(r.statuses)}`);
  }
}
for (const name of process.env.LOAD_MIX === '1' ? [] : wanted) {
  const def = scenarios[name];
  if (!def) throw new Error(`Unknown scenario ${name}`);
  if (!sessions.has(def.user)) sessions.set(def.user, await login(def.user));
  // One warm-up request so first-call caches and JIT do not dominate a short run.
  const warm = def.request();
  await fetch(`${API}${warm.path}`, {
    method: warm.method,
    headers: { cookie: cookieHeader(sessions.get(def.user)), ...CSRF, ...(warm.json ? { 'content-type': 'application/json' } : {}) },
    body: warm.json ? JSON.stringify(warm.json) : warm.body,
  }).then((r) => r.text());
  const r = await runScenario(name, def, sessions.get(def.user));
  results.push(r);
  console.log(
    `${name.padEnd(18)} c=${String(r.concurrency).padStart(3)} n=${String(r.requests).padStart(6)} rps=${String(r.rps).padStart(7)} ` +
      `p50=${r.p50}ms p95=${r.p95}ms p99=${r.p99}ms max=${r.max}ms err=${r.errorRate}% ${JSON.stringify(r.statuses)}`,
  );
}
if (process.env.LOAD_OUT) writeFileSync(process.env.LOAD_OUT, `${JSON.stringify({ api: API, at: new Date().toISOString(), durationS: DURATION_MS / 1000, results }, null, 2)}\n`);
