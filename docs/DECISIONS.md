# Build decisions (confirmed 2026-11-20)

- First deliverable: Platform foundation + NGAO TALLY MVP (roadmap stages 1 and 4).
- Stack: blueprint stack. pnpm + Turborepo monorepo; apps/web (Next.js + TS, PWA), apps/api (NestJS), PostgreSQL with RLS, Prisma (chosen over TypeORM), Redis + BullMQ, S3-compatible storage (MinIO; local-filesystem driver for dev/tests).
- Geography: county-agnostic data model (47 counties / constituencies / wards / centres / stations); demo seed uses SYNTHETIC Bungoma stations.
- First end-to-end rehearsal contest: County Governor (Forms 37A / 37B / 37C). Data model and form-template registry must support all six positions (34–39 series).
- All demo data is synthetic (candidates, stations, totals). No real voter data.
- The parallel tally is never labelled official; no winner/elected/declared language.
