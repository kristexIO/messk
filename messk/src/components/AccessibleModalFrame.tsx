import { useEffect, useRef, type ReactNode } from 'react';

type AccessibleModalFrameProps = {
  children: ReactNode;
  titleId: string;
  descriptionId?: string;
  onClose?: () => void;
  role?: 'dialog' | 'alertdialog';
  className: string;
  panelClassName: string;
};

export function AccessibleModalFrame({
  children,
  titleId,
  descriptionId,
  onClose,
  role = 'dialog',
  className,
  panelClassName,
}: AccessibleModalFrameProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => {
      panelRef.current?.focus();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !onClose) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      }
    };
  }, [onClose]);

  return (
    <div className={className}>
      <div
        ref={panelRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className={panelClassName}
      >
        {children}
      </div>
    </div>
  );
}
