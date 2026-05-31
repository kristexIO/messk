import { type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  FlaskConical,
  LockKeyhole,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  experimentalTrustControls,
  implementedTrustControls,
  latestTrustHighlights,
  productionTrustBlockers,
  publicThreatModel,
  publicTrustDisclosure,
  trustEvidenceBars,
  trustMetrics,
  trustStatusChart,
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

function TrustMetricGrid() {
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Trust center evidence metrics">
      {trustMetrics.map((metric) => (
        <article key={metric.label} className="rounded-3xl border border-white/10 bg-white/[0.05] p-5">
          <div className="text-3xl font-bold text-white">{metric.value}</div>
          <div className="mt-2 text-sm font-semibold text-white">{metric.label}</div>
          <p className="mt-2 text-xs leading-5 text-text-muted">{metric.detail}</p>
        </article>
      ))}
    </section>
  );
}

function TrustStatusChart() {
  const total = trustStatusChart.reduce((sum, segment) => sum + segment.count, 0);

  return (
    <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5 sm:p-7" aria-label="Trust claim status chart">
      <div className="mb-5 flex items-center gap-3">
        <BarChart3 className="h-6 w-6 text-accent" />
        <div>
          <h2 className="text-xl font-semibold">Claim status mix</h2>
          <p className="text-sm text-text-muted">Count of public claims by maturity. This is not an audit score.</p>
        </div>
      </div>
      <div className="flex h-4 overflow-hidden rounded-full bg-white/10">
        {trustStatusChart.map((segment) => (
          <div
            key={segment.label}
            className="h-full"
            style={{ width: `${(segment.count / total) * 100}%`, backgroundColor: segment.color }}
            aria-label={`${segment.label}: ${segment.count}`}
          />
        ))}
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {trustStatusChart.map((segment) => (
          <article key={segment.label} className="rounded-2xl border border-white/[0.08] bg-black/20 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-semibold">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: segment.color }} />
                {segment.label}
              </span>
              <span className="text-lg font-bold">{segment.count}</span>
            </div>
            <p className="mt-2 text-xs leading-5 text-text-muted">{segment.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function TrustEvidenceChart() {
  return (
    <section className="rounded-[28px] border border-white/10 bg-white/[0.04] p-5 sm:p-7" aria-label="Trust evidence coverage chart">
      <div className="mb-5 flex items-center gap-3">
        <Activity className="h-6 w-6 text-accent" />
        <div>
          <h2 className="text-xl font-semibold">Evidence coverage map</h2>
          <p className="text-sm text-text-muted">Operational view of what is backed by automation or still bounded by disclosure.</p>
        </div>
      </div>
      <div className="space-y-5">
        {trustEvidenceBars.map((bar) => {
          const percent = Math.round((bar.value / bar.max) * 100);

          return (
            <article key={bar.label}>
              <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                <span className="font-semibold text-white">{bar.label}</span>
                <span className="text-text-muted">{bar.value}/{bar.max}</span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: bar.color }} />
              </div>
              <p className="mt-2 text-xs leading-5 text-text-muted">{bar.detail}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function LatestTrustHighlights() {
  return (
    <section className="rounded-[28px] border border-accent/20 bg-accent/[0.07] p-5 sm:p-7">
      <div className="mb-5 flex items-center gap-3">
        <TrendingUp className="h-6 w-6 text-accent" />
        <div>
          <h2 className="text-xl font-semibold">Latest shipped evidence</h2>
          <p className="text-sm text-text-muted">Recent work that changed what users and operators can verify.</p>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {latestTrustHighlights.map((highlight) => (
          <article key={highlight.title} className="rounded-2xl border border-white/[0.08] bg-black/20 p-4">
            <h3 className="font-semibold text-white">{highlight.title}</h3>
            <p className="mt-2 text-sm leading-6 text-text-muted">{highlight.summary}</p>
            <p className="mt-3 border-t border-white/[0.08] pt-3 text-xs leading-5 text-white/55">
              Evidence: {highlight.evidence}
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

        <TrustMetricGrid />

        <div className="mt-6 grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <TrustStatusChart />
          <TrustEvidenceChart />
        </div>

        <div className="mt-6">
          <LatestTrustHighlights />
        </div>

        <div className="mt-6 grid gap-5 lg:grid-cols-3">
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
