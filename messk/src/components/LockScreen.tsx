import React, { useEffect, useState } from 'react';
import { useAppStore } from '../store';
import { Lock, Unlock, ShieldCheck } from 'lucide-react';
import { verifyPin } from '../lib/security';

export const LockScreen: React.FC = () => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const { setLocked, pinHash } = useAppStore();

  const handleUnlock = async () => {
    if (pin.length !== 4 || !pinHash) return;
    const isValid = await verifyPin(pin, pinHash);
    if (isValid) {
      setError('');
      setPin('');
      setLocked(false);
    } else {
      setError('Incorrect PIN');
      setPin('');
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (/^\d$/.test(event.key) && pin.length < 4) {
        setPin((current) => `${current}${event.key}`.slice(0, 4));
        setError('');
        return;
      }

      if (event.key === 'Backspace') {
        setPin((current) => current.slice(0, -1));
        setError('');
        return;
      }

      if (event.key === 'Enter') {
        if (pin.length === 4 && pinHash) {
          void verifyPin(pin, pinHash).then((isValid) => {
            if (isValid) {
              setError('');
              setPin('');
              setLocked(false);
            } else {
              setError('Incorrect PIN');
              setPin('');
            }
          });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pin, pinHash, setLocked]);

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/40 backdrop-blur-3xl">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[20%] left-[20%] w-[30%] h-[30%] bg-accent/10 rounded-full blur-[100px]" />
        <div className="absolute bottom-[20%] right-[20%] w-[30%] h-[30%] bg-blue-500/10 rounded-full blur-[100px]" />
      </div>

      <div className="premium-glass p-10 rounded-[40px] w-[360px] flex flex-col items-center gap-8 animate-in zoom-in-95 duration-500 shadow-2xl border border-white/10 relative z-10">
        <div className="w-20 h-20 rounded-3xl bg-accent/20 flex items-center justify-center shadow-2xl shadow-accent/20 border border-accent/30 group">
          <Lock className="w-10 h-10 text-accent group-hover:scale-110 transition-transform" />
        </div>

        <div className="text-center">
          <h2 className="text-2xl font-bold tracking-tight">App Locked</h2>
          <p className="text-sm text-text-muted mt-2">Enter your 4-digit security PIN</p>
        </div>

        <div className="flex gap-4" aria-label="PIN progress">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className={`w-4 h-4 rounded-full transition-all duration-300 shadow-inner ${pin.length >= i ? 'bg-accent scale-125 shadow-[0_0_10px_var(--accent-glow)]' : 'bg-white/10'}`}
            />
          ))}
        </div>

        <div className="h-4 text-xs text-red-400">{error}</div>

        <div className="grid grid-cols-3 gap-4 w-full">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 'C', 0, 'OK'].map((val) => (
            <button
              key={val}
              onClick={() => {
                if (val === 'C') {
                  setPin('');
                  setError('');
                } else if (val === 'OK') {
                  void handleUnlock();
                } else if (pin.length < 4) {
                  setPin(`${pin}${val}`);
                  setError('');
                }
              }}
              className={`
                w-full h-16 rounded-2xl flex items-center justify-center text-xl font-bold transition-all
                ${val === 'OK' ? 'bg-accent text-white hover:bg-accent/80' : 'bg-white/5 hover:bg-white/10 border border-white/5'}
                active:scale-90
              `}
              aria-label={val === 'OK' ? 'Unlock app' : val === 'C' ? 'Clear PIN' : `Digit ${val}`}
            >
              {val === 'OK' ? <Unlock className="w-6 h-6" /> : val}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-[10px] text-text-muted uppercase tracking-[0.2em] font-bold opacity-50 mt-4">
          <ShieldCheck className="w-3.5 h-3.5" />
          Secure Shield Active
        </div>
      </div>
    </div>
  );
};
