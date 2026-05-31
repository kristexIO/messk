import type { InterfaceDensity, InterfaceDensityOption } from '../lib/interfaceDensity';
import { interfaceDensityOptions } from '../lib/interfaceDensity';

type InterfaceDensitySelectorProps = {
  value: InterfaceDensity;
  onChange: (value: InterfaceDensity) => void;
  options?: readonly InterfaceDensityOption[];
  isLoading?: boolean;
  hasError?: boolean;
};

export function InterfaceDensitySelector({
  value,
  onChange,
  options = interfaceDensityOptions,
  isLoading = false,
  hasError = false,
}: InterfaceDensitySelectorProps) {
  const headingId = 'interface-density-heading';
  const helpId = 'interface-density-help';

  if (isLoading) {
    return (
      <div className="settings-card rounded-2xl p-4" aria-labelledby={headingId}>
        <div id={headingId} className="mb-3 text-xs uppercase tracking-[0.22em] text-text-muted">
          Density
        </div>
        <div role="status" aria-live="polite" className="rounded-xl border border-white/10 bg-black/15 px-3 py-3 text-xs text-text-muted">
          Loading interface density options...
        </div>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="settings-card rounded-2xl p-4" aria-labelledby={headingId}>
        <div id={headingId} className="mb-3 text-xs uppercase tracking-[0.22em] text-text-muted">
          Density
        </div>
        <div role="alert" className="rounded-xl border border-amber-300/20 bg-amber-300/10 px-3 py-3 text-xs leading-5 text-amber-100">
          Density settings are unavailable. The comfortable layout remains active.
        </div>
      </div>
    );
  }

  if (options.length === 0) {
    return (
      <div className="settings-card rounded-2xl p-4" aria-labelledby={headingId}>
        <div id={headingId} className="mb-3 text-xs uppercase tracking-[0.22em] text-text-muted">
          Density
        </div>
        <div className="rounded-xl border border-white/10 bg-black/15 px-3 py-3 text-xs leading-5 text-text-muted">
          No density options are available. Comfortable spacing stays enabled.
        </div>
      </div>
    );
  }

  return (
    <div className="settings-card rounded-2xl p-4" role="group" aria-labelledby={headingId} aria-describedby={helpId}>
      <div id={headingId} className="mb-3 text-xs uppercase tracking-[0.22em] text-text-muted">
        Density
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {options.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            aria-pressed={value === item.id}
            aria-describedby={`interface-density-${item.id}-description interface-density-${item.id}-metric`}
            className={`settings-choice interface-density-choice rounded-xl px-3 py-3 text-left transition-all ${value === item.id ? 'is-active' : ''}`}
          >
            <div className={`interface-density-preview is-${item.id}`} aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div className="mt-3 text-xs font-semibold">{item.name}</div>
            <div id={`interface-density-${item.id}-description`} className="mt-1 text-[10px] leading-4 text-text-muted">
              {item.description}
            </div>
            <div id={`interface-density-${item.id}-metric`} className="mt-2 text-[10px] leading-4 text-text-muted">
              {item.metric}
            </div>
          </button>
        ))}
      </div>
      <p id={helpId} className="mt-3 text-[11px] leading-5 text-text-muted">
        Density is stored locally in settings and changes only spacing, never message contents or encryption keys.
      </p>
    </div>
  );
}

