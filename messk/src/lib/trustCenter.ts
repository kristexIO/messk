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
