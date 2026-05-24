# Security Policy

Messk is built around ciphertext-only server behavior and client-owned identity
state. Security issues are taken seriously, especially anything that could leak
plaintext, weaken authentication, bypass file access control, or expose
production infrastructure.

## Supported Branches

The active development branch is `main`. Security fixes should target `main`
first and then be included in the next release artifact.

## Reporting A Vulnerability

Please do not open a public issue for a suspected vulnerability.

Report privately through GitHub's private vulnerability reporting flow if it is
available for this repository. If that is not available, contact the repository
owner directly and include:

- affected component: backend, web client, Windows client, shared core, deploy,
  or documentation;
- reproduction steps and expected impact;
- any relevant request/response examples with secrets removed;
- whether the issue affects local development, production deploys, or both.

## Security Expectations

- The backend must never receive message plaintext, decrypted files, identity
  seeds, ratchet secrets, or local session secrets.
- Uploaded file bytes are expected to be encrypted before upload.
- Session tokens and file tokens must not be logged or committed.
- Production `.env` files, certificates, private keys, databases, and uploads
  must stay outside git.
- Public health endpoints must not expose database, queue, socket, upload, or
  session-count metrics; those belong on authenticated or loopback-only admin
  surfaces.
- Protocol changes must update backend validation, web contract tests, and
  `clients/core` mirrors together.
- Deploy changes must preserve health checks, backups, rollback, UFW, nginx
  limits, and fail2ban behavior.

## Production Notes

The VPS deploy script pins the SSH host key, configures nginx
request/connection limits, UFW, fail2ban, sysctl TCP hardening, systemd
sandboxing, swap, and verified release backups. This helps with common
HTTP/WebSocket abuse, but it does not replace upstream volumetric DDoS
protection from a hosting provider or a dedicated edge service.

Messk has not been independently audited. Do not present it as audited
cryptographic infrastructure until a qualified external review has happened.
