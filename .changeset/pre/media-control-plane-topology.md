---
'@adonis-agora/media': minor
'@adonis-agora/media-dashboard': minor
---

Control plane and tenants: several apps can keep their media on one central app. `config/media.ts` gains `topology: 'standalone' | 'control-plane' | 'tenant'`.

- **Control plane** (`topology: 'control-plane'`, `verifyTenant`, `controlPlane: { prefix, collections, maxBytes, accounts }`): mounts the tenant API under `/_media/v1`. Each request carries an app's service token (`authkitTenantVerifier({ issuer, resource: 'urn:agora:media' })` or `sharedSecretVerifier({ partitions })`); the app and its capabilities (`media:read`, `media:write`) come from the token. Each app's records and files are kept apart (owner type `<app>/<ownerType>`, keys under `<app>/`), and the control plane runs the collections' rules and conversions.
- **Tenant** (`topology: 'tenant'`, `tenant: { url, partition, token, urls, timeoutMs, uploadTimeoutMs, retries }`): `media.library` keeps its API (`attach`, `list`, `find`, `for`, `page`, `rename`, `delete`, `ensureConversion`, `url`, `signedUrl`, `image`, `deliver`) and runs it on the control plane; `media.access` and the delivery route work unchanged. `url` takes `controlPlaneUrl({ issuer, resource: 'urn:agora:media' })`. URLs point at the app's own delivery route by default (`urls: 'app'`), or at the control plane's storage URLs (`urls: 'control-plane'`). A control plane that does not answer fails every call fast with `MediaControlPlaneError` (`503`, `E_MEDIA_CONTROL_PLANE_UNAVAILABLE`); its refusals keep their status and code.
- **Account files** (`controlPlane.accounts`): a person's own files shared by every app (an avatar). Apps read them with their service token; the person writes and removes them with their own access token. In a tenant: `media.accounts.serve()`, `read()`, `records()`, `replace()`, `remove()`.
- **Console**: `apps` entries with `mode: 'control-plane'` list the control plane's tenant apps (their media lives here, actions run here), hinted **control plane** in the App selector.
- `agora:doctor` checks `media.topology` and `media.control-plane` (the tenant reaches the control plane, and its token is accepted for its app with `media:read` and `media:write`). A tenant describes itself to telescope as using the control plane for its media files.
