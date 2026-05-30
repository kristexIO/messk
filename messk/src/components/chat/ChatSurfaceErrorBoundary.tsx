import { AlertTriangle, ArrowLeft, RotateCcw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { getSafeUiRecoveryCopy, logUiRenderError } from '../../lib/uiErrorRecovery';

type ChatSurfaceErrorBoundaryProps = {
  children: ReactNode;
  resetKey: string;
  onBackToList: () => void;
};

type ChatSurfaceErrorBoundaryState = {
  hasError: boolean;
};

export class ChatSurfaceErrorBoundary extends Component<
  ChatSurfaceErrorBoundaryProps,
  ChatSurfaceErrorBoundaryState
> {
  state: ChatSurfaceErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ChatSurfaceErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    logUiRenderError('chat-surface', error, info.componentStack ?? undefined);
  }

  componentDidUpdate(prevProps: ChatSurfaceErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const copy = getSafeUiRecoveryCopy('chat-surface');

    return (
      <section
        className="chat-stage flex w-full flex-1 flex-col items-center justify-center px-6 text-center"
        role="alert"
        aria-live="assertive"
      >
        <div className="w-full max-w-md rounded-3xl border border-amber-300/20 bg-slate-950/80 p-6 shadow-2xl">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-300/20 bg-amber-300/10 text-amber-200">
            <AlertTriangle className="h-7 w-7" aria-hidden="true" />
          </div>
          <h2 className="mt-5 text-xl font-semibold text-white">{copy.title}</h2>
          <p className="mt-3 text-sm leading-6 text-text-muted">{copy.body}</p>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={() => this.setState({ hasError: false })}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-accent/30 bg-accent/15 px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-accent/25"
            >
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              {copy.primaryAction}
            </button>
            <button
              type="button"
              onClick={this.props.onBackToList}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-white/80 transition-all hover:bg-white/[0.08] hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {copy.secondaryAction}
            </button>
          </div>
        </div>
      </section>
    );
  }
}
