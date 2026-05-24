# Supported Versions And Release Channels

## Channels

| Channel | Purpose | Promotion rule |
| --- | --- | --- |
| `stable` | User-facing supported builds | Must pass full CI, staging evidence, backup, rollback and production smoke gates. |
| `beta` | Staging and compatibility exercises | Must not be promoted as production without a new `stable` build and production gate. |

Release manifests record the selected channel. Channel labeling is not a
digital signature and does not replace verification of artifact provenance.

## Protocol Compatibility

The backend public `/protocol` endpoint is the compatibility source of truth.
The current contract is:

| Field | Current value |
| --- | --- |
| `protocolVersion` | `1` |
| `requiredClientStateVersion` | `clean_20260511` |

Web and Windows clients must refuse realtime connection with a clear update
message when their local state is not listed as supported.

## End-Of-Life Policy

- A client state becomes unsupported only with a documented migration reason,
  an updated `/protocol` response, matching tests, and stable release notes.
- Security-critical client states may be retired immediately after a fixed
  stable release is available; the advisory must explain user action.
- Non-security removals should retain an upgrade window through at least one
  stable release cycle where practical.
- Unsupported builds may still open local data, but must not silently connect
  using an incompatible realtime protocol.
