import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERFACE_DENSITY,
  applyInterfaceDensityAttribute,
  getInterfaceDensityOption,
  interfaceDensityOptions,
  normalizeInterfaceDensity,
} from './interfaceDensity';

describe('interface density contract', () => {
  it('defaults malformed stored values to the comfortable layout', () => {
    expect(normalizeInterfaceDensity('compact')).toBe('compact');
    expect(normalizeInterfaceDensity('comfortable')).toBe('comfortable');
    expect(normalizeInterfaceDensity('tiny')).toBe(DEFAULT_INTERFACE_DENSITY);
    expect(normalizeInterfaceDensity(null)).toBe(DEFAULT_INTERFACE_DENSITY);
  });

  it('keeps public option copy free of private or diagnostic data', () => {
    const text = interfaceDensityOptions.map((option) => Object.values(option).join(' ')).join(' ');

    expect(interfaceDensityOptions).toHaveLength(2);
    expect(text).toMatch(/desktop/i);
    expect(text).toMatch(/touch/i);
    expect(text).not.toMatch(/seed|secret|token|public key|message text/i);
  });

  it('normalizes before writing the document density attribute', () => {
    const attributes: Record<string, string> = {};
    const root = {
      setAttribute(name: string, value: string) {
        attributes[name] = value;
      },
    };

    expect(applyInterfaceDensityAttribute('compact', root)).toBe('compact');
    expect(attributes['data-density']).toBe('compact');

    expect(applyInterfaceDensityAttribute('unsupported', root)).toBe('comfortable');
    expect(attributes['data-density']).toBe('comfortable');
  });

  it('returns the normalized option for exported settings summaries', () => {
    expect(getInterfaceDensityOption('compact').name).toBe('Compact');
    expect(getInterfaceDensityOption('bad-value').id).toBe(DEFAULT_INTERFACE_DENSITY);
  });
});

