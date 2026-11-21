# Build decisions (confirmed 2026-11-20)

- First deliverable: Platform foundation + NGAO TALLY MVP (roadmap stages 1 and 4).
- Stack: blueprint stack. pnpm + Turborepo monorepo; apps/web (Next.js + TS, PWA), apps/api (NestJS), PostgreSQL with RLS, Prisma (chosen over TypeORM), Redis + BullMQ, S3-compatible storage (MinIO; local-filesystem driver for dev/tests).
- Geography: county-agnostic data model (47 counties / constituencies / wards / centres / stations); demo seed uses SYNTHETIC Bungoma stations.
- First end-to-end rehearsal contest: County Governor (Forms 37A / 37B / 37C). Data model and form-template registry must support all six positions (34–39 series).
- All demo data is synthetic (candidates, stations, totals). No real voter data.
- The parallel tally is never labelled official; no winner/elected/declared language.

## Update (2026-11-20)
- Pilot customer: a County Governor (campaign + governor's office). Governor contest (37A/B/C) is the primary end-to-end flow; NGAO360 Office is the next environment to build after the tally MVP.
- Demo/pilot data: past public election data (2022 General Election) may be used for the demo and pilot, imported through the registry/form-import paths and labelled as historical 2022 data, never as live or official results. Synthetic data remains the default seed for automated tests.

## Update (2026-11-21)
- Production domain: **ngao360.co.ke**. The application runs on `app.ngao360.co.ke` (API under `/api`, citizen portal under `/p/<organisation>`); the bare domain and `www` redirect to it with the path kept; staging is `staging.ngao360.co.ke`; e-mail is sent from `notify.ngao360.co.ke`. Passkeys are bound to `ngao360.co.ke`. Details and DNS records in `docs/DEPLOYMENT.md`.
