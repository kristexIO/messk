import { describe, expect, it } from 'vitest';
import definition from './scenarios.json';

type VisualState = 'normal' | 'empty' | 'loading' | 'error';
type VisualViewport = 'mobile' | 'tablet' | 'desktop';

type VisualScenario = {
  id: string;
  baseline: string;
  title: string;
  viewport: VisualViewport;
  state: VisualState;
  cards: Array<{
    label: string;
    tone: string;
    width: number;
  }>;
  assertions: string[];
};

type VisualDefinition = {
  schemaVersion: number;
  requiredStates: VisualState[];
  requiredViewports: VisualViewport[];
  scenarios: VisualScenario[];
};

const visualDefinition = definition as VisualDefinition;

const forbiddenPrivateDetails = [
  /seed phrase/i,
  /secret key/i,
  /\btoken\b/i,
  /\bsdp\b/i,
  /\bice\b/i,
  /\bcandidate\b/i,
  /public key/i,
  /message text/i,
  /raw diagnostics/i,
];

describe('visual regression scenario contract', () => {
  it('uses stable identifiers and baseline names', () => {
    const ids = visualDefinition.scenarios.map((scenario) => scenario.id);

    expect(visualDefinition.schemaVersion).toBe(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());

    for (const scenario of visualDefinition.scenarios) {
      expect(scenario.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(scenario.baseline).toBe(`${scenario.id}.svg`);
      expect(scenario.cards.length).toBeGreaterThan(0);
      expect(scenario.assertions).toContain('synthetic-data');
    }
  });

  it('covers required states and responsive viewports', () => {
    const states = new Set(visualDefinition.scenarios.map((scenario) => scenario.state));
    const viewports = new Set(visualDefinition.scenarios.map((scenario) => scenario.viewport));

    for (const state of visualDefinition.requiredStates) {
      expect(states.has(state)).toBe(true);
    }

    for (const viewport of visualDefinition.requiredViewports) {
      expect(viewports.has(viewport)).toBe(true);
    }
  });

  it('keeps visual baselines synthetic and privacy bounded', () => {
    for (const scenario of visualDefinition.scenarios) {
      const serialized = JSON.stringify(scenario);

      for (const forbidden of forbiddenPrivateDetails) {
        expect(serialized).not.toMatch(forbidden);
      }
    }
  });
});
