# 2022 historical data for the demo and pilot (checked 2026-11-20)

This session could not reach forms.iebc.or.ke, iebc.or.ke or HDX, so anything marked UNCONFIRMED needs checking before it is relied on.

## What is public
- **Presidential forms (34A / 34B / 34C): scanned images on the IEBC public portal.**
  - Portal: https://forms.iebc.or.ke/. Per-county bulk download is at `#/downloads?contest=34`.
  - About 46,201 34As were uploaded.
  - File name pattern: `1_34_A_<15-digit station code>_<KIEMS serial>_<YYYYMMDD>_<HHMMSS>`.
  - The station code appears to be county(3) + constituency(3) + ward(4) + centre(3) + station(2). This breakdown is inferred, not documented.
  - Whether the 2022 archive is still online is UNCONFIRMED.
- **Governor forms (37A / 37B / 37C) were not published electronically.** IEBC transmitted only the presidential forms (KICTANet, AU-COMESA observer mission). Governor figures are public only at county level, in the Kenya Gazette notice of about 23 Aug 2022 listing the governors-elect. Kakamega and Mombasa were gazetted later in Gazette Notice 10535. Whether those notices give every candidate's votes is UNCONFIRMED.
- **Station-level presidential figures:**
  - github.com/ib0b/kenya-elections-ocr, file `forms-export.csv`: crowdsourced, about 30k of 46k stations, no licence, marked "education purposes only".
  - No official CSV exists.
- **Polling-station list:**
  - No official machine-readable list with codes.
  - The list can be rebuilt from the station codes in the 34A file names, then joined to the IEBC PDF of registered voters per station.
  - github.com/Armani-T/2022-iebc-boundaries (MIT licence) has county, constituency and ward names only.

## Legal notes
- Section 25 of the Copyright Act gives the Government copyright in government works.
- Vote figures are facts, but the scanned images may be protected.
- The scans show presiding officers' and agents' names and signatures, so the Data Protection Act 2019 applies.
- Before any commercial demo:
  - Get written permission from IEBC.
  - Credit the source.
  - Do not use the IEBC logo in a way that implies endorsement.
  - Blur names and signatures on any images shown.
  - Do not redistribute the ib0b dataset commercially.

## Recommended demo design
- **Real layer: the 2022 presidential race in the pilot county.** The full chain runs on real data: 34A images → capture → two-person verify → constituency aggregate → compare with the real 34B → compare with the county figure in 34C.
- **Governor layer: simulated.** Generate synthetic 37A / 37B forms for the pilot county whose totals match the gazetted 2022 county governor totals. Label it clearly as simulated.
- **Synthetic:**
  - agent identities, devices and submission timing;
  - station figures not covered by a usable source.
- **County choice:**
  - Bungoma (code 039, inferred) fits the pilot story.
  - Lamu (005) is small enough for a quick end-to-end test.
  - Avoid Kakamega and Mombasa (governor races postponed) and Nairobi (too large).

## Sources
- Carter Center 2022 final report: https://www.cartercenter.org/resources/pdfs/news/peace_publications/election_reports/kenya-2022-elections-final-report.pdf
- KICTANet: https://www.kictanet.or.ke/?mdocs-file=48220
- Governors gazetted: https://www.the-star.co.ke/news/2022-08-23-iebc-gazettes-45-governors-elect-and-their-deputies
- ib0b dataset: https://github.com/ib0b/kenya-elections-ocr
- IEBC registered voters per constituency: https://www.iebc.or.ke/docs/rov_per_constituency.pdf
