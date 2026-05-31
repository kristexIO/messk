import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useAppStore } from './store';
import { Toaster } from 'react-hot-toast';
import { LockScreen } from './components/LockScreen';
import { Component, lazy, Suspense, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react';
import { useI18n } from './lib/i18n';
import { getSafeUiRecoveryCopy, logUiRenderError } from './lib/uiErrorRecovery';
import { RouteLoadingFallback } from './components/RouteLoadingFallback';

const Auth = lazy(async () => {
  const module = await import('./pages/Auth');
  return { default: module.Auth };
});

const TrustCenter = lazy(async () => {
  const module = await import('./pages/TrustCenter');
  return { default: module.TrustCenter };
});

const AuthenticatedSession = lazy(async () => {
  const module = await import('./components/AuthenticatedSession');
  return { default: module.AuthenticatedSession };
});

type AppErrorBoundaryState = {
  hasError: boolean;
};

class AppErrorBoundary extends Component<{ children: ReactNode }, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return {
      hasError: true,
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    logUiRenderError('app', error, info.componentStack ?? undefined);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const copy = getSafeUiRecoveryCopy('app');

    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0e1621] px-4 text-white">
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#17212b] p-5 shadow-none">
          <div className="text-lg font-semibold">{copy.title}</div>
          <p className="mt-2 text-sm leading-6 text-white/70">
            {copy.body}
          </p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-xl bg-[#2aabee] px-4 py-2 text-sm font-semibold text-white"
            >
              {copy.primaryAction}
            </button>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false })}
              className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white/80"
            >
              {copy.secondaryAction}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

function App() {
  const { mySecretKey, isLocked, isRestoringIdentity, restoreRememberedIdentity, autoLockMinutes, lockApp } = useAppStore();
  const { t } = useI18n();
  const lastActivityRef = useRef(0);

  useEffect(() => {
    void restoreRememberedIdentity();
  }, [restoreRememberedIdentity]);

  useEffect(() => {
    if (!mySecretKey || !autoLockMinutes || isLocked) {
      return;
    }

    lastActivityRef.current = Date.now();
    const markActivity = () => {
      lastActivityRef.current = Date.now();
    };
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivityRef.current >= autoLockMinutes * 60_000) {
        lockApp();
      }
    }, 15_000);
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    events.forEach((eventName) => window.addEventListener(eventName, markActivity, { passive: true }));

    return () => {
      window.clearInterval(timer);
      events.forEach((eventName) => window.removeEventListener(eventName, markActivity));
    };
  }, [autoLockMinutes, isLocked, lockApp, mySecretKey]);

  return (
    <Router>
      <Toaster position="top-center" toastOptions={{
        style: {
          background: 'var(--tg-panel)',
          color: 'var(--text-main)',
          borderRadius: '10px',
          border: '1px solid var(--tg-line)',
          boxShadow: 'none',
        }
      }} />
      <AppErrorBoundary>
        <Routes>
          <Route path="/trust" element={
            <Suspense fallback={<RouteLoadingFallback route="trust" />}>
              <TrustCenter />
            </Suspense>
          } />
          <Route path="*" element={
            <Suspense fallback={<RouteLoadingFallback route={mySecretKey ? 'session' : 'auth'} />}>
              <>
                {isLocked && <LockScreen />}
                {isRestoringIdentity ? (
                  <RouteLoadingFallback route="session" detailOverride={t('restoringSession')} />
                ) : mySecretKey ? <AuthenticatedSession /> : <Auth />}
              </>
            </Suspense>
          } />
        </Routes>
      </AppErrorBoundary>
    </Router>
  );
}

export default App;
