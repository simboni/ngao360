# Research brief (2026-11-20)

Desk research done alongside the blueprint. Items marked UNCONFIRMED need a primary-source check. odpc.go.ke and kenyalaw.org could not be reached from the build environment.

## Election context
- Election day: Tue 10 Aug 2027. Party primaries close 9 May 2027. Nominations run 29 May – 11 Jun 2027. Campaigns run 29 May – 7 Aug 2027. Polling stations are gazetted 4–8 Jul 2027. Projected register: ~28.5M voters.
- No revised 34A–39D form templates found yet (UNCONFIRMED). IEBC has a draft Elections (General) (Amendment) Regulations, and the Elections (Amendment) Bill would codify the physical Form 34A as the primary record.
  - **Design implication:** the uploaded paper-form image is the source of truth, and templates stay versioned and configurable.
- About 55,000 polling stations are projected, up from 46,229 in 2022, capped at 700 voters per station. The 2027 station list is not yet published and historically comes out as a PDF or gazette notice.
  - **Design implication:** the registry import must handle ~55k rows and PDF-to-CSV conversion workflows.
- Boundary review is postponed until after 2027: 47 counties, 290 constituencies, 1,450 wards.
- Election Campaign Financing Regulations 2026 were gazetted 7 Aug 2026. They set caps (e.g. presidential ~KSh 6.1B, Nairobi governor ~KSh 181M), limit single-source contributions to 20%, and require dedicated Kenyan bank accounts. They are under court challenge and parliamentary dispute, so it is UNCONFIRMED whether they are in force.
  - **Design implication:** finance limits and dates are tenant-configurable, never hardcoded.

## Machine-readable geography (pre-2027, verify dates)
- Open Elections Kenya: CSV of polling centres with GPS, plus GeoJSON for counties, constituencies and wards. https://open-elections-kenya.vercel.app/resources.html
- pkiage/data-Kenya-Counties-Constituencies-Wards (CSV/XLSX).
- Kenya P-codes (HDX); an older IEBC polling-station shapefile (BTAA geoportal).

## Data protection (Data Protection Act 2019)
- ODPC registration is mandatory for anyone processing data to canvass political support, regardless of size. NGAO360 (as processor) and each tenant (as controller) likely both need to register.
- A DPIA (s.31) is required before high-risk processing.
- Breach notification: the controller must notify ODPC within 72h (s.43). The processor must notify the controller within 48h (secondary source).
- There is no general data-localisation rule. "Strategic interest" processing must have a copy held in Kenya (UNCONFIRMED whether election data counts). Foreign cloud hosting counts as a cross-border transfer under the 2026 guidance.
  - **Design implication:** offer Kenya-region hosting, or a copy held in Kenya, as a deployment option.

## Integrations
- Africa's Talking SMS: API key; delivery reports via callback; branded sender ID approval takes ~2–14 business days.
- Safaricom Daraja (M-Pesa): OAuth client credentials; STK Push, C2B and B2C; HTTPS callbacks; a signed letter is needed to go live.

## OCR
- Tesseract is weak on handwriting and tables.
- Recommended approach: PaddleOCR (PP-OCRv5) or docTR to detect and crop the fixed field boxes, then a small digit classifier or TrOCR to read them.
- OCR is used only as a pre-fill. Build a labelled test set from real form field crops.

## Prior art
- ELOG 2022 PVT: a statistically sampled set of stations, rigorous verification, and published margins of error (projected 50.7% ±2.1% vs the official 50.49%). Parallel tallies that ran at different speeds confused the public.
  - **Design implication:** always show completeness and coverage, and label the tally unofficial.
- NDI Apollo (github.com/nditech/apollo): observer rosters, checklist schemas, verification queues. A good design reference.
- Uchaguzi (Ushahidi): plan 6–12 months ahead, run simulations, and cross-check crowd reports against reports from trained monitors.

## Toolchain versions seen (verify with `npm view`)
Next.js 16.x, NestJS 12.x (ESM), Prisma 7.x (8 was at release candidate), Node 24/26 LTS, PostgreSQL 18 (or 19, just released), pnpm 11, Turborepo 2.10.
