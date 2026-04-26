import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { useAppStore } from './store';
import { Toaster } from 'react-hot-toast';
import { LockScreen } from './components/LockScreen';
import { lazy, Suspense, useEffect, useState } from 'react';
import { socketManager } from './lib/socket';
import { initNotifications, isTauri } from './lib/notifications';
import { OnboardingModal } from './components/OnboardingModal';

const Auth = lazy(async () => {
  const module = await import('./pages/Auth');
  return { default: module.Auth };
});

const Chat = lazy(async () => {
  const module = await import('./pages/Chat');
  return { default: module.Chat };
});

function App() {
  const { mySecretKey, isLocked } = useAppStore();
  const [hasDismissedOnboarding, setHasDismissedOnboarding] = useState(
    () => localStorage.getItem('messk_onboarding_seen') === '1'
  );
  const showOnboarding = Boolean(mySecretKey && !isLocked && !hasDismissedOnboarding);

  useEffect(() => {
    // Init native notifications & autostart (Tauri only)
    if (isTauri) {
      initNotifications();
      // Enable autostart silently
      import('@tauri-apps/plugin-autostart').then(({ enable, isEnabled }) => {
        isEnabled().then((enabled) => {
          if (!enabled) enable();
        });
      });
    }

    const handleUnload = () => {
      socketManager.disconnect();
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
    };
  }, [mySecretKey]);

  return (
    <Router>
      <Toaster position="top-center" toastOptions={{
        style: {
          background: '#1f2937',
          color: '#fff',
          borderRadius: '12px',
          border: '1px solid #374151',
        }
      }} />
      <Routes>
        <Route path="*" element={
          <Suspense fallback={<div className="min-h-screen bg-[#020617]" />}>
            <>
              {isLocked && <LockScreen />}
              {showOnboarding && mySecretKey && !isLocked ? (
                <OnboardingModal
                  onClose={() => {
                    localStorage.setItem('messk_onboarding_seen', '1');
                    setHasDismissedOnboarding(true);
                  }}
                />
              ) : null}
              {mySecretKey ? <Chat /> : <Auth />}
            </>
          </Suspense>
        } />
      </Routes>
    </Router>
  );
}

export default App;
