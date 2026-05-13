# Messk Frontend

React browser client for the E2EE messenger. Native desktop work lives in
`clients/windows`.

## Configuration

Create `.env` from `.env.example`:

```powershell
VITE_BACKEND_URL=http://localhost:8080
```

For reliable calls across mobile networks and strict NATs, production builds should also define TURN relay settings:

```powershell
VITE_TURN_URLS=turn:messk.online:3478?transport=udp,turn:messk.online:3478?transport=tcp,turns:messk.online:5349?transport=tcp
VITE_TURN_USERNAME=turn-user
VITE_TURN_CREDENTIAL=turn-password
```

## Local Checks

```powershell
npm ci
npm run lint
npm test
npm run build
```

## Release Notes

- Backup export intentionally excludes identity keys and ratchet session secrets.
- PQC is disabled until a real ML-KEM implementation is wired in.
- Production builds should use a reviewed backend origin.
- Production calls need a real TURN relay. STUN-only setups will fail on part of the internet even when chat delivery works.
