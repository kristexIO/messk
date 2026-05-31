import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { RouteLoadingFallback } from './RouteLoadingFallback';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(route: React.ComponentProps<typeof RouteLoadingFallback>['route']) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<RouteLoadingFallback route={route} />);
  });
  return container;
}

describe('RouteLoadingFallback', () => {
  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container?.remove();
    root = null;
    container = null;
  });

  it('renders a polite loading status for lazy routes', () => {
    const element = render('chat');
    const status = element.querySelector('[role="status"]');

    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-label')).toBe('Loading chat workspace');
    expect(element.textContent).toContain('Preparing encrypted conversations');
  });

  it('does not expose raw route diagnostics', () => {
    const element = render('trust');

    expect(element.textContent).toContain('Loading trust center');
    expect(element.textContent).not.toMatch(/seed phrase|secret key|\btoken\b|\bsdp\b|\bice\b|\bcandidate\b|message text|raw diagnostics/i);
  });
});
