import React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { X, ShieldCheck, QrCode, Copy } from 'lucide-react';
import { useI18n } from '../lib/i18n';

interface Props {
  pubKey: string;
  onClose: () => void;
}

export const UserIdentityModal: React.FC<Props> = ({ pubKey, onClose }) => {
  const { t } = useI18n();
  const chatUrl = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return pubKey;
    }
    return `${window.location.origin}${window.location.pathname}?chat=${encodeURIComponent(pubKey)}`;
  }, [pubKey]);

  return (
    <div className="fixed inset-0 z-[600] flex items-center justify-center bg-black/60 backdrop-blur-xl p-4">
      <div className="premium-glass p-8 rounded-[32px] w-full max-w-sm flex flex-col items-center gap-6 animate-in zoom-in-95 duration-300 shadow-2xl border border-white/10">
        <div className="w-full flex justify-between items-center">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <QrCode className="text-accent w-5 h-5" />
            {t('identityCard')}
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-full transition-colors">
            <X className="w-5 h-5 text-text-muted" />
          </button>
        </div>

        <div className="bg-white p-6 rounded-[24px] shadow-2xl relative overflow-hidden group">
          <div className="absolute inset-0 bg-accent/5 opacity-0 group-hover:opacity-100 transition-opacity" />
          <QRCodeSVG value={chatUrl} size={220} level="H" includeMargin={true} />
        </div>

        <div className="text-center w-full">
          <p className="text-[10px] text-text-muted uppercase tracking-[0.2em] font-bold mb-3">{t('publicKeyIdentity')}</p>
          <div className="bg-black/40 p-4 rounded-2xl border border-white/5 break-all font-mono text-[10px] text-accent select-all shadow-inner">
            {pubKey}
          </div>
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(chatUrl)}
            className="mt-3 inline-flex items-center gap-2 rounded-xl border border-white/10 px-3 py-2 text-xs text-text-muted transition-all hover:border-white/20 hover:text-white"
          >
            <Copy className="h-3.5 w-3.5" />
            {t('chatLink')}
          </button>
        </div>

        <div className="flex items-center gap-4 p-5 bg-accent/5 rounded-2xl border border-accent/10 text-[11px] text-text-muted leading-relaxed">
          <ShieldCheck className="w-6 h-6 text-accent flex-shrink-0" />
          <p>{t('scanIdentity')}</p>
        </div>
      </div>
    </div>
  );
};
