import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccessibleModalFrame } from './AccessibleModalFrame';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(onClose = vi.fn()) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <AccessibleModalFrame
        titleId="test-dialog-title"
        descriptionId="test-dialog-description"
        onClose={onClose}
        className="modal-backdrop"
        panelClassName="modal-panel"
      >
        <h2 id="test-dialog-title">Create chat</h2>
        <p id="test-dialog-description">Dialog copy stays generic and safe.</p>
        <button type="button">Confirm</button>
      </AccessibleModalFrame>
    );
  });
  return { element: container, onClose };
}

describe('AccessibleModalFrame', () => {
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

  it('renders a labelled modal dialog and closes on Escape', () => {
    const { element, onClose } = render();
    const dialog = element.querySelector('[role="dialog"]');

    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    expect(dialog?.getAttribute('aria-labelledby')).toBe('test-dialog-title');
    expect(dialog?.getAttribute('aria-describedby')).toBe('test-dialog-description');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not expose raw secret or diagnostic wording in its standard copy', () => {
    const { element } = render();

    expect(element.textContent).toContain('Dialog copy stays generic');
    expect(element.textContent).not.toMatch(/seed|secret key|token|sdp|ice|message plaintext/i);
  });
});

