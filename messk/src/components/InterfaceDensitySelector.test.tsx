import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InterfaceDensitySelector } from './InterfaceDensitySelector';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(element: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
  });
  return container;
}

describe('InterfaceDensitySelector', () => {
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

  it('renders accessible density choices and emits selected value', () => {
    const onChange = vi.fn();
    const element = render(<InterfaceDensitySelector value="comfortable" onChange={onChange} />);

    const group = element.querySelector('[role="group"]');
    expect(group?.textContent).toContain('Comfortable');
    expect(group?.textContent).toContain('Compact');

    const compactButton = Array.from(element.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Compact')
    );
    expect(compactButton?.getAttribute('aria-pressed')).toBe('false');

    act(() => {
      compactButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith('compact');
  });

  it('covers loading, empty and error states without leaking raw diagnostics', () => {
    const loading = render(<InterfaceDensitySelector value="comfortable" onChange={() => undefined} isLoading />);
    expect(loading.querySelector('[role="status"]')?.textContent).toContain('Loading interface density options');

    act(() => {
      root?.render(<InterfaceDensitySelector value="comfortable" onChange={() => undefined} options={[]} />);
    });
    expect(container?.textContent).toContain('No density options are available');

    act(() => {
      root?.render(<InterfaceDensitySelector value="comfortable" onChange={() => undefined} hasError />);
    });
    expect(container?.querySelector('[role="alert"]')?.textContent).toContain('comfortable layout remains active');
    expect(container?.textContent).not.toMatch(/seed|secret|token|message text|public key/i);
  });
});

