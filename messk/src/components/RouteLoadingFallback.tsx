import type { LazyRouteId } from '../lib/lazyRoutes';
import { getLazyRouteCopy } from '../lib/lazyRoutes';

type RouteLoadingFallbackProps = {
  route: LazyRouteId;
  detailOverride?: string;
};

export function RouteLoadingFallback({ route, detailOverride }: RouteLoadingFallbackProps) {
  const copy = getLazyRouteCopy(route);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={copy.ariaLabel}
      className="flex min-h-screen items-center justify-center bg-[#020617] px-4 text-white"
    >
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#17212b] p-5 text-center shadow-none">
        <div className="mx-auto h-8 w-8 animate-pulse rounded-full border border-[#2aabee]/40 bg-[#2aabee]/15" aria-hidden="true" />
        <div className="mt-4 text-sm font-semibold">{copy.title}</div>
        <p className="mt-2 text-xs leading-5 text-white/60">{detailOverride ?? copy.detail}</p>
      </div>
    </div>
  );
}

