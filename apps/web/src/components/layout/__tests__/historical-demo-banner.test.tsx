/**
 * The historical demo label on every screen (docs/DEMO_2022.md).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { HISTORICAL_DEMO_LABEL, PARALLEL_TALLY_BANNER } from '@ngao360/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { HistoricalDemoBanner } from '../../ui/historical-demo-banner';

describe('HistoricalDemoBanner', () => {
  it('renders nothing for an ordinary organisation', () => {
    assert.equal(renderToStaticMarkup(<HistoricalDemoBanner label={null} />), '');
  });

  it('shows the demo label together with the unofficial wording', () => {
    const html = renderToStaticMarkup(<HistoricalDemoBanner label={HISTORICAL_DEMO_LABEL} notice="Station figures are SIMULATED." />);
    assert.ok(html.includes(HISTORICAL_DEMO_LABEL));
    assert.ok(html.includes(PARALLEL_TALLY_BANNER));
    assert.ok(html.includes('SIMULATED'));
    assert.ok(html.includes('role="note"'));
  });

  it('is mounted by the desktop and mobile shells for every screen', () => {
    for (const file of ['../app-shell.tsx', '../../mobile/mobile-shell.tsx']) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      assert.match(src, /<HistoricalDemoBanner label=\{[^}]*tenant\.dataLabel\}/, file);
    }
  });
});
