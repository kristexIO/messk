import { type ReactNode } from 'react';
import { AlertTriangle, ArrowLeft, FlaskConical, LockKeyhole, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  experimentalTrustControls,
  implementedTrustControls,
  productionTrustBlockers,
  publicThreatModel,
  publicTrustDisclosure,
  type TrustItem,
} from '../lib/trustCenter';

type TrustSectionProps = {
  title: string;
  subtitle: string;
  icon: ReactNode;
  items: TrustItem[];
};

function TrustSection({ title, subtitle, icon, items }: TrustSectionProps) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5 sm:p-6">
      <div className="mb-5 flex items-start gap-3">
        <div className="mt-0.5 rounded-xl border border-white/10 bg-white/[0.05] p-2 text-accent">{icon}</div>
        <div>
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <p className="mt-1 text-sm leading-6 text-text-muted">{subtitle}</p>
        </div>
      </div>
      <div className="space-y-4">
        {items.map((item) => (
          <article key={item.title} className="rounded-2xl border border-white/[0.08] bg-black/20 p-4">
            <h3 className="font-semibold text-white">{item.title}</h3>
            <p className="mt-2 text-sm leading-6 text-text-muted">{item.summary}</p>
            <p className="mt-3 border-t border-white/[0.08] pt-3 text-xs leading-5 text-white/55">
              Evidence: {item.evidence}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function TrustCenter() {
  return (
    <div className="auth-screen min-h-[100dvh] w-full overflow-y-auto bg-gradient-to-br from-[#020617] via-[#0f172a] to-[#1e1b4b] px-4 py-6 text-white sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-6xl">
        <Link
          to="/"
          className="mb-8 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm text-text-muted transition-colors hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to sign in
        </Link>

        <header className="mb-8 rounded-[30px] premium-glass p-6 sm:p-9">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-accent">
            <ShieldCheck className="h-4 w-4" />
            Public trust center
          </div>
          <h1 className="max-w-3xl text-3xl font-bold tracking-tight sm:text-5xl">Security claims should be verifiable.</h1>
          <p className="mt-5 max-w-3xl text-sm leading-7 text-text-muted sm:text-base">
            This page states what Messk implements today, what remains experimental, and what must be completed before a production security claim.
          </p>
          <div className="mt-6 flex gap-3 rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm leading-6 text-amber-100">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
            <p>{publicTrustDisclosure}</p>
          </div>
        </header>

        <div className="grid gap-5 lg:grid-cols-3">
          <TrustSection
            title="Implemented today"
            subtitle="Controls present in the client or release gate and backed by tests."
            icon={<ShieldCheck className="h-5 w-5" />}
            items={implementedTrustControls}
          />
          <TrustSection
            title="Staged or experimental"
            subtitle="Implemented or explored, but not a complete production promise."
            icon={<FlaskConical className="h-5 w-5" />}
            items={experimentalTrustControls}
          />
          <TrustSection
            title="Blocks production claims"
            subtitle="Outstanding obligations that must remain visible until completed."
            icon={<AlertTriangle className="h-5 w-5" />}
            items={productionTrustBlockers}
          />
        </div>

        <section className="mt-6 rounded-[28px] border border-white/10 bg-white/[0.04] p-5 sm:p-7">
          <div className="mb-6 flex items-center gap-3">
            <LockKeyhole className="h-6 w-6 text-accent" />
            <div>
              <h2 className="text-xl font-semibold">Plain-language threat model</h2>
              <p className="text-sm text-text-muted">The limits matter as much as the encryption claim.</p>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {publicThreatModel.map((item) => (
              <article key={item.title} className="rounded-2xl border border-white/[0.08] bg-black/20 p-4">
                <h3 className="font-semibold">{item.title}</h3>
                <p className="mt-2 text-sm leading-6 text-text-muted">{item.description}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
