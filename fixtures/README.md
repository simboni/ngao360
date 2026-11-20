# Fixtures

**Everything in this folder is SYNTHETIC.** Only county codes and names are real public
reference data. Constituency, ward, polling-centre and station names, codes and
registered-voter figures are invented for rehearsal and testing. Do not present them as
IEBC data.

## `registry/`

CSV files for `POST /api/reference/registry-versions/:id/import` (multipart field `file`).

| File | Purpose |
| --- | --- |
| `bungoma-synthetic-2027-r1.csv` | The registry the seed loads as `SYNTHETIC-2027-R1`: Bungoma (039), 9 constituencies, 45 wards, 90 polling centres, 153 stations. |
| `bungoma-synthetic-2027-r2-amendment.csv` | A second version for the versioning demo: 1 station withdrawn, 2 added, 1 station renamed, 1 ward renamed and some registered-voter figures revised. Import it into a new DRAFT version. The validation report then shows the diff against R1 and a `UNIT_RENAMED` warning. |
| `bungoma-synthetic-invalid-sample.csv` | Rows that are rejected for an unknown county, a wrong county name, a duplicate station code, a non-numeric voter figure and an inconsistent parent, plus one row with a warning for a missing voter figure. Use it to see the validation report. |

### Columns

Required: `county_code, county_name, constituency_code, constituency_name, ward_code,
ward_name, station_code, station_name`.

Optional: `centre_code, centre_name` (polling centres are optional, but if you give one you
must give both), `registered_voters` (left empty when unknown; estimates are never
substituted), `stream_number`, `latitude, longitude` (both or neither), `location_source`.

The county code must be one of the 47 official codes (001–047), and the county name must
match it. Codes are at most 32 characters: letters, digits, `- _ / .`.

### Regenerating

The files are generated from `packages/db/src/seed/synthetic-bungoma.ts`:

```bash
pnpm --filter @ngao360/db exec tsx src/seed/write-fixtures.ts          # write
pnpm --filter @ngao360/db exec tsx src/seed/write-fixtures.ts --check  # verify unchanged
```
