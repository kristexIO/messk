import { describe, expect, it } from 'vitest';
import {
  experimentalTrustControls,
  implementedTrustControls,
  productionTrustBlockers,
  publicThreatModel,
  publicTrustDisclosure,
} from './trustCenter';

describe('public trust center contract', () => {
  it('discloses alpha and independent review status', () => {
    expect(publicTrustDisclosure).toMatch(/alpha software/i);
    expect(publicTrustDisclosure).toMatch(/not been independently audited/i);
    expect(publicTrustDisclosure).toMatch(/not treat it as production-ready/i);
  });

  it('keeps production blockers separate from implemented claims', () => {
    expect(implementedTrustControls.every((item) => item.status === 'implemented')).toBe(true);
    expect(experimentalTrustControls.every((item) => item.status === 'experimental')).toBe(true);
    expect(productionTrustBlockers.every((item) => item.status === 'release-blocker')).toBe(true);
    expect(implementedTrustControls.map((item) => item.title)).toContain('Confirmed local panic reset');
    expect(productionTrustBlockers.map((item) => item.title)).toContain('Independent security review');
    expect(productionTrustBlockers.map((item) => item.title)).toContain('Staged production promotion');
  });

  it('states metadata and disabled-mesh limitations plainly', () => {
    expect(experimentalTrustControls.find((item) => item.title === 'Metadata resistance')?.summary)
      .toMatch(/metadata remains/i);
    expect(experimentalTrustControls.find((item) => item.title === 'Mesh transport prototype')?.summary)
      .toMatch(/disabled/i);
    expect(publicThreatModel.some((item) => /relay can still observe/i.test(item.title))).toBe(true);
  });
});
