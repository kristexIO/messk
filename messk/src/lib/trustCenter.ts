export type TrustStatus = 'implemented' | 'experimental' | 'release-blocker';

export type TrustItem = {
  title: string;
  status: TrustStatus;
  summary: string;
  evidence: string;
};

export type ThreatModelItem = {
  title: string;
  description: string;
};

export type TrustMetric = {
  label: string;
  value: string;
  detail: string;
};

export type TrustChartSegment = {
  label: string;
  count: number;
  color: string;
  description: string;
};

export type TrustEvidenceBar = {
  label: string;
  value: number;
  max: number;
  color: string;
  detail: string;
};

export type TrustHighlight = {
  title: string;
  summary: string;
  evidence: string;
};

export const publicTrustDisclosure =
  'Messk is alpha software and has not been independently audited. Do not treat it as production-ready security software.';

export const implementedTrustControls: TrustItem[] = [
  {
    title: 'Encrypted direct message contents',
    status: 'implemented',
    summary: 'Direct message bodies and message attachments are encrypted on the client before relay delivery.',
    evidence: 'Client crypto, ratchet, attachment and protocol tests are required by the release gate.',
  },
  {
    title: 'Locally held identity secret',
    status: 'implemented',
    summary: 'A seed phrase derives the account identity locally. The relay is not given the seed phrase.',
    evidence: 'Identity setup, backup and remembered-identity paths are covered by client tests.',
  },
  {
    title: 'Local key status without secret exposure',
    status: 'implemented',
    summary: 'Settings shows whether identity, PIN restore, local database scoping and auto-lock are ready without printing raw seed or secret-key material.',
    evidence: 'Local key status tests assert the posture contract and reject raw secret wording.',
  },
  {
    title: 'Versioned encrypted backup manifest',
    status: 'implemented',
    summary: 'Encrypted backups include a manifest with record counts and explicit exclusions for identity seeds, secret keys, ratchet sessions, prekeys and group sender keys.',
    evidence: 'Backup tests verify the manifest and that encrypted backup JSON does not expose plaintext or secret field names.',
  },
  {
    title: 'Reliable delivery status labels',
    status: 'implemented',
    summary: 'Outgoing messages use a shared delivery-status contract so direct and group messages do not imply unsupported read receipts.',
    evidence: 'Delivery-status tests cover pending, failed, delivered, read and group distributed states.',
  },
  {
    title: 'Safe chat surface recovery',
    status: 'implemented',
    summary: 'Chat rendering failures are contained inside the conversation surface and the fallback does not print raw error messages, keys or message text.',
    evidence: 'Chat surface error boundary tests verify sanitized recovery copy and non-leaking fallback UI.',
  },
  {
    title: 'Accessible offline and reconnect indicators',
    status: 'implemented',
    summary: 'Direct, group and channel surfaces show connection, retry queue and metadata-sync state with screen-reader status regions and aggregate counts only.',
    evidence: 'Connection-health tests cover offline, reconnect, queued delivery and sanitized sync-error states.',
  },
  {
    title: 'Accessible modal and call controls',
    status: 'implemented',
    summary: 'Critical dialogs and call actions expose labelled dialog semantics, Escape handling, live status regions and explicit keyboard-readable control labels.',
    evidence: 'Accessible modal frame and call-control tests verify dialog labels, Escape close behavior, assertive call alerts and generic non-secret assistive copy.',
  },
  {
    title: 'Lazy route bundle boundaries',
    status: 'implemented',
    summary: 'The public app shell, auth screen, chat workspace and trust center load through separate route fallbacks so authenticated chat bootstrap does not inflate first paint.',
    evidence: 'Lazy-route tests validate safe fallback copy, and the frontend bundle budget gate verifies route chunks plus authenticated-only marker isolation.',
  },
  {
    title: 'Visual regression baselines',
    status: 'implemented',
    summary: 'Normal, empty, loading and recovered chat states have deterministic responsive baselines so layout regressions are caught before release.',
    evidence: 'Visual regression scenario tests require mobile, tablet and desktop coverage, while the release gate verifies generated SVG baselines are current and synthetic.',
  },
  {
    title: 'Reduced temporary secret lifetime',
    status: 'implemented',
    summary: 'Mutable secret buffers used for message, attachment, backup, seed and PIN operations are cleared after use where the runtime permits it.',
    evidence: 'Web and native zeroization regression tests run in the release gate.',
  },
  {
    title: 'Confirmed local panic reset',
    status: 'implemented',
    summary: 'The web client can delete Messk PIN restore data, settings, identity records and local encrypted databases from this browser profile after an explicit RESET confirmation.',
    evidence: 'Panic reset regression tests verify Messk localStorage keys and IndexedDB databases are removed without touching unrelated origin data.',
  },
  {
    title: 'Release and compatibility gates',
    status: 'implemented',
    summary: 'Stable artifacts identify their source commit and incompatible protocol or disabled-feature calls fail closed.',
    evidence: 'Manifest, protocol and staging-gate checks run before release promotion.',
  },
];

export const experimentalTrustControls: TrustItem[] = [
  {
    title: 'Relay and bootstrap operation',
    status: 'experimental',
    summary: 'Relay-backed delivery is implemented for testing, but remains in staged promotion until deployment evidence is collected.',
    evidence: 'The release process requires smoke verification against a separate staging origin.',
  },
  {
    title: 'Metadata resistance',
    status: 'experimental',
    summary: 'Padding and identifier controls reduce some exposure, but relay-visible routing and timing metadata remains.',
    evidence: 'Metadata limitations are documented and are not presented as full anonymity.',
  },
  {
    title: 'Mesh transport prototype',
    status: 'experimental',
    summary: 'Mesh transport is a research path and is disabled for supported production builds.',
    evidence: 'Production feature policy and protocol negotiation reject unsupported mesh use.',
  },
];

export const productionTrustBlockers: TrustItem[] = [
  {
    title: 'Independent security review',
    status: 'release-blocker',
    summary: 'No independent security audit has been completed.',
    evidence: 'A completed review report and remediation record are required before a production security claim.',
  },
  {
    title: 'Signed Windows distribution',
    status: 'release-blocker',
    summary: 'A trusted signed installer and verification path are not yet delivered.',
    evidence: 'Signed build artifacts and install verification evidence remain mandatory release work.',
  },
  {
    title: 'Native realtime media support',
    status: 'release-blocker',
    summary: 'The native Windows client deliberately rejects unsupported realtime media behavior.',
    evidence: 'Fail-closed native tests keep the unsupported path disabled.',
  },
  {
    title: 'Staged production promotion',
    status: 'release-blocker',
    summary: 'Production deployment must not proceed without fresh evidence from the exact commit on a distinct staging origin.',
    evidence: 'Deployment scripts enforce staging evidence and pinned SSH host trust.',
  },
];

export const publicThreatModel: ThreatModelItem[] = [
  {
    title: 'What encryption protects',
    description: 'A functioning client is designed to keep direct message and attachment plaintext away from the relay server and network observers.',
  },
  {
    title: 'What the relay can still observe',
    description: 'Delivery timing, account identifiers, connection information and other routing metadata may remain visible to service operators.',
  },
  {
    title: 'What a lost secret exposes',
    description: 'Anyone who obtains your seed phrase or an unlocked device can act as you and may read locally accessible conversations.',
  },
  {
    title: 'What users must verify',
    description: 'Protect the seed phrase offline and confirm contact identity changes through a trusted channel before continuing sensitive chats.',
  },
];

const regressionEvidenceCount = implementedTrustControls.filter((item) =>
  /test|gate|budget|baseline/i.test(item.evidence),
).length;

export const trustMetrics: TrustMetric[] = [
  {
    label: 'Implemented controls',
    value: implementedTrustControls.length.toString(),
    detail: 'Public claims backed by repository evidence.',
  },
  {
    label: 'Regression evidence',
    value: regressionEvidenceCount.toString(),
    detail: 'Implemented controls with tests, gates, budgets or baselines.',
  },
  {
    label: 'Responsive baselines',
    value: '4',
    detail: 'Normal, empty, loading and recovery states across device sizes.',
  },
  {
    label: 'Production blockers',
    value: productionTrustBlockers.length.toString(),
    detail: 'Kept visible until external evidence exists.',
  },
];

export const trustStatusChart: TrustChartSegment[] = [
  {
    label: 'Implemented',
    count: implementedTrustControls.length,
    color: '#34d399',
    description: 'Shipped controls with local evidence.',
  },
  {
    label: 'Experimental',
    count: experimentalTrustControls.length,
    color: '#38bdf8',
    description: 'Staged work that must not be oversold.',
  },
  {
    label: 'Blocked',
    count: productionTrustBlockers.length,
    color: '#fb7185',
    description: 'Mandatory before production security claims.',
  },
];

export const trustEvidenceBars: TrustEvidenceBar[] = [
  {
    label: 'Automated evidence',
    value: regressionEvidenceCount,
    max: implementedTrustControls.length,
    color: '#34d399',
    detail: 'Tests, release gates, bundle checks and visual baselines.',
  },
  {
    label: 'Public limitations',
    value: experimentalTrustControls.length + productionTrustBlockers.length,
    max: implementedTrustControls.length + experimentalTrustControls.length + productionTrustBlockers.length,
    color: '#f59e0b',
    detail: 'Experimental items and blockers shown before users sign in.',
  },
  {
    label: 'Native parity signals',
    value: 4,
    max: 6,
    color: '#38bdf8',
    detail: 'Identity, direct chat, attachments/voice and typing are native; realtime media remains blocked.',
  },
];

export const latestTrustHighlights: TrustHighlight[] = [
  {
    title: 'Visual regression gate',
    summary: 'The release path now verifies synthetic responsive SVG baselines so UI states do not drift silently.',
    evidence: 'scripts/visual-regression-baselines.ps1 and messk/visual-regression/scenarios.json',
  },
  {
    title: 'Windows typing parity',
    summary: 'The native client sends and displays transient direct typing indicators compatible with the web client.',
    evidence: 'clients/windows/src/net.rs, clients/windows/src/app.rs and protocol tests',
  },
  {
    title: 'Route budget visibility',
    summary: 'The public shell, auth flow, chat workspace and trust center keep separate lazy route boundaries.',
    evidence: 'scripts/frontend-bundle-budget.ps1 and lazy route regression tests',
  },
];
