import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatSurfaceErrorBoundary } from './ChatSurfaceErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function ThrowingChatContent(): ReactNode {
  throw new Error('private seed phrase and message plaintext must never render');
}

describe('ChatSurfaceErrorBoundary', () => {
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

  it('renders a safe chat fallback without leaking the thrown error message', () => {
    const onBackToList = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <ChatSurfaceErrorBoundary resetKey="thread-a" onBackToList={onBackToList}>
          <ThrowingChatContent />
        </ChatSurfaceErrorBoundary>
      );
    });

    expect(container.textContent).toContain('Chat recovered');
    expect(container.textContent).toContain('raw diagnostics stay hidden');
    expect(container.textContent).not.toContain('private seed phrase');
    expect(container.textContent).not.toContain('message plaintext');

    const backButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Back to chats')
    );
    expect(backButton).toBeTruthy();
    act(() => {
      backButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onBackToList).toHaveBeenCalledTimes(1);

    consoleError.mockRestore();
  });
});
