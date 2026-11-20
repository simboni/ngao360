# Open questions for the product owner

Defaults applied while these are open are noted next to each.

1. Pilot county: default **Bungoma**. Alternative for a quick test: Lamu.
2. Crowdsourced 2022 34A CSV (ib0b, unlicensed): default **not used**. The demo transcribes figures from local scans instead.
3. Network access to forms.iebc.or.ke / www.iebc.or.ke for the 2022 import: default **not requested**. The importer works from local files.
4. Hosting region and SMS/email vendors (e.g. Africa's Talking): default **pluggable drivers with console/log fallbacks**.
5. Written IEBC permission for commercial use of scanned forms: needed before any public demo using real scans.
6. Verified 2022 Bungoma County Governor figures: every candidate's votes, rejected votes and registered voters from the Kenya Gazette notice (about 23 Aug 2022) or another official IEBC publication, with the exact reference, and the candidate names as gazetted. Default **UNVERIFIED placeholders and neutral labels** ("Candidate A (simulated)") in `data/demo-2022/bungoma.config.json`; station-level governor figures stay simulated in any case (docs/DEMO_2022.md §4).
7. IEBC constituency, ward and polling-station codes for Bungoma: default **inferred** 15-digit pattern county(3) + constituency(3) + ward(4) + centre(3) + station(2) with placeholder constituency and ward codes numbered in list order. Wanted: the real codes (readable from 34A file names) and confirmation of the pattern.
8. Bungoma ward list (45 wards in 9 constituencies, as commonly published for the 2012 boundaries): default **used but marked unverified**; confirm against the IEBC list or the MIT boundary list.
9. Redaction procedure for officers' and agents' names and signatures on real 34A scans (with the written IEBC permission in item 5) before any public or commercial demo that shows them: default **every imported scan is held "not for display until redacted"**, also with `--redacted` (which only records the operator's declaration); a different person with `tally.approve` releases it with `pnpm demo:redact-34a` (redacted copy, or confirmation of a declared redaction), audited with reviewer and reason.
