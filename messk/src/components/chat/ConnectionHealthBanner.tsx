import { Clock3, RefreshCw, WifiOff } from 'lucide-react';
import {
  getConnectionHealthToneClass,
  type ConnectionHealthItem,
  type ConnectionHealthIcon,
} from '../../lib/connectionHealth';

type ConnectionHealthBannerProps = {
  items: ConnectionHealthItem[];
  className?: string;
};

function ConnectionHealthIconView({ icon }: { icon: ConnectionHealthIcon }) {
  if (icon === 'clock') {
    return <Clock3 className="h-4 w-4" aria-hidden="true" />;
  }
  if (icon === 'sync') {
    return <RefreshCw className="h-4 w-4" aria-hidden="true" />;
  }
  return <WifiOff className="h-4 w-4" aria-hidden="true" />;
}

export function ConnectionHealthBanner({ items, className = '' }: ConnectionHealthBannerProps) {
  if (items.length === 0) {
    return null;
  }

  const liveMode = items.some((item) => item.live === 'assertive') ? 'assertive' : 'polite';

  return (
    <section
      className={`space-y-3 ${className}`}
      role="status"
      aria-live={liveMode}
      aria-label="Connection and delivery status"
    >
      {items.map((item) => (
        <article
          key={item.id}
          className={`rounded-2xl border px-4 py-3 text-sm ${getConnectionHealthToneClass(item.tone)}`}
        >
          <div className="flex items-center gap-2 font-medium">
            <ConnectionHealthIconView icon={item.icon} />
            {item.title}
          </div>
          <div className="mt-1 text-xs opacity-80">{item.detail}</div>
        </article>
      ))}
    </section>
  );
}
