export type InterfaceDensity = 'compact' | 'comfortable';

export type InterfaceDensityOption = {
  id: InterfaceDensity;
  name: string;
  description: string;
  metric: string;
};

export const DEFAULT_INTERFACE_DENSITY: InterfaceDensity = 'comfortable';

export const interfaceDensityOptions: readonly InterfaceDensityOption[] = [
  {
    id: 'comfortable',
    name: 'Comfortable',
    description: 'More breathing room for long reading and touch screens.',
    metric: 'Best default for mixed desktop, tablet and phone use.',
  },
  {
    id: 'compact',
    name: 'Compact',
    description: 'Tighter lists, message bubbles and settings cards.',
    metric: 'Keeps dense workspaces usable without hiding controls.',
  },
];

export function isInterfaceDensity(value: unknown): value is InterfaceDensity {
  return value === 'compact' || value === 'comfortable';
}

export function normalizeInterfaceDensity(value: unknown): InterfaceDensity {
  return isInterfaceDensity(value) ? value : DEFAULT_INTERFACE_DENSITY;
}

export function getInterfaceDensityOption(value: unknown): InterfaceDensityOption {
  const normalized = normalizeInterfaceDensity(value);
  return interfaceDensityOptions.find((option) => option.id === normalized) ?? interfaceDensityOptions[0];
}

export function applyInterfaceDensityAttribute(
  value: unknown,
  root: Pick<Element, 'setAttribute'> | null | undefined = typeof document === 'undefined'
    ? null
    : document.documentElement
): InterfaceDensity {
  const normalized = normalizeInterfaceDensity(value);
  root?.setAttribute('data-density', normalized);
  return normalized;
}

