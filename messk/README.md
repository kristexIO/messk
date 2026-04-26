# Messk Frontend

React + Tauri desktop client for the E2EE messenger.

## Configuration

Create `.env` from `.env.example`:

```powershell
VITE_BACKEND_URL=http://localhost:8080
```

The Tauri CSP in `src-tauri/tauri.conf.json` must also allow the production backend origin before packaging a non-local build.

## Local Checks

```powershell
npm run lint
npm test
npm run build
```

For the desktop shell:

```powershell
cd src-tauri
cargo check
```

## Release Notes

- Backup export intentionally excludes identity keys and ratchet session secrets.
- PQC is disabled until a real ML-KEM implementation is wired in.
- Production builds should use a reviewed backend origin and matching Tauri CSP.
