import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionHealthBanner } from './ConnectionHealthBanner';
import type { ConnectionHealthItem } from '../../lib/connectionHealth';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(items: ConnectionHealthItem[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<ConnectionHealthBanner items={items} />);
  });
  return container;
}

describe('ConnectionHealthBanner', () => {
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

  it('renders an assertive status region when any item requires attention', () => {
    const element = render([
      {
        id: 'connection-offline',
        title: 'Offline',
        detail: 'Messages retry automatically.',
        tone: 'danger',
        icon: 'wifi-off',
        live: 'assertive',
      },
    ]);

    const region = element.querySelector('[role="status"]');
    expect(region?.getAttribute('aria-live')).toBe('assertive');
    expect(element.textContent).toContain('Offline');
    expect(element.textContent).toContain('Messages retry automatically.');
  });

  it('does not render an empty status region', () => {
    const element = render([]);
    expect(element.querySelector('[role="status"]')).toBeNull();
  });
});
