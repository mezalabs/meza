---
title: "infra: Subdomain split for landing page deployment"
type: infra
status: active
date: 2026-03-29
---

# Infrastructure: Subdomain Split

## Overview

Split `meza.chat` into three subdomains to support the new static landing page on Cloudflare Pages:

| Subdomain | Serves | Hosted On |
|-----------|--------|-----------|
| `meza.chat` | Astro landing page | Cloudflare Pages |
| `app.meza.chat` | React SPA | Server (Traefik / Caddy) |
| `api.meza.chat` | Go microservices + WebSocket | Server (Traefik / Caddy) |

All changes are in `mezalabs/infra`. The `mezalabs/meza` repo changes (noindex meta, getBaseUrl, SW cleanup) are already done.

## Changes Required

### 1. K8s Ingress Routes (`k8s/ingress/routes.yml`)

Currently all routes match `Host('meza.chat')`. Remap:

- [ ] Change HTTP redirect to match `Host('app.meza.chat') || Host('api.meza.chat')`
- [ ] Move SPA catch-all (`client-web`, priority 1) to `Host('app.meza.chat')`
- [ ] Move all API routes (`/meza.v1.*`, `/media/`) to `Host('api.meza.chat')`
- [ ] Move WebSocket route (`/ws`) to `Host('api.meza.chat')`
- [ ] Move LiveKit route (`/rtc`) to `Host('api.meza.chat')` (or dedicated `lk.meza.chat` if preferred)
- [ ] Remove all `Host('meza.chat')` rules — Cloudflare Pages handles that now
- [ ] Update TLS secretName if cert changes (see TLS section)

### 2. K8s Middleware (`k8s/ingress/middleware.yml`)

**security-headers:**
- [ ] Update CSP `connect-src` from `wss://meza.chat` to `wss://api.meza.chat`
- [ ] Update CSP to allow `https://app.meza.chat` origin if needed

**mobile-cors:**
- [ ] Add `https://app.meza.chat` to `accessControlAllowOriginList` (the SPA is now cross-origin to the API)

**New web-cors middleware (may be needed):**
- [ ] The SPA at `app.meza.chat` calling API at `api.meza.chat` is cross-origin. Currently only `mobile-cors` exists for Capacitor. May need a broader CORS middleware that covers both web and mobile origins, applied to all API routes.

### 3. K8s ConfigMap (`k8s/configmaps/meza-config.yml`)

- [ ] `MEZA_ALLOWED_ORIGINS`: add `https://app.meza.chat` → `"https://meza.chat,https://app.meza.chat,capacitor://localhost,https://localhost"`
- [ ] `MEZA_LIVEKIT_PUBLIC_URL`: change from `wss://meza.chat` to `wss://api.meza.chat`

### 4. Docker Compose (`docker/docker-compose.prod.yml`)

The compose file references `../Caddyfile.prod`. Equivalent changes:

- [ ] Update Caddyfile.prod to route `app.meza.chat` to SPA static files
- [ ] Update Caddyfile.prod to route `api.meza.chat` to gateway/services
- [ ] Remove `meza.chat` server block (handled by Cloudflare Pages)
- [ ] Update env vars in `.env` to match configmap changes

### 5. TLS / Certificates

- [ ] Check if current Cloudflare origin cert covers `*.meza.chat` or just `meza.chat`
- [ ] If not wildcard: regenerate origin cert with SANs for `app.meza.chat` and `api.meza.chat`
- [ ] Update k8s secret `cloudflare-origin-tls` with new cert if needed
- [ ] Ansible role may need updating if it provisions the cert

### 6. DNS (Cloudflare Dashboard)

- [ ] Lower TTL for `meza.chat` to 60s before cutover
- [ ] Create `app.meza.chat` → A/CNAME to server IP
- [ ] Create `api.meza.chat` → A/CNAME to server IP
- [ ] Connect Cloudflare Pages project to repo, add `meza.chat` custom domain
- [ ] After verification: switch `meza.chat` from server to Cloudflare Pages
- [ ] Verify all three subdomains resolve correctly
- [ ] Restore TTL to 3600s

### 7. Cloudflare Pages Setup

- [ ] Connect `mezalabs/meza` repo to Cloudflare Pages
- [ ] Build settings: root directory `client/packages/landing`, command `pnpm build`, output `dist`
- [ ] Build watch paths: `client/packages/landing/**`
- [ ] Add custom domain `meza.chat`
- [ ] Set up deploy hook for automated rebuilds after `desktop-v*` releases

### 8. SPA Build Config

When building the SPA for production after the subdomain split:

- [ ] Set `VITE_API_URL=https://api.meza.chat` in the build environment (CI or docker build args)
- [ ] This makes `getBaseUrl()` return the API origin for both HTTP and WebSocket connections

## Rollback Plan

If issues arise during DNS cutover:

1. Revert `meza.chat` DNS back to server IP
2. Revert k8s ingress routes to `Host('meza.chat')`
3. Revert configmap origins

The old single-domain setup will resume working immediately since the Caddy/Traefik config changes are independent of DNS.

## Order of Operations

1. Generate new TLS cert (if needed) and update k8s secret
2. Deploy updated k8s ingress + middleware + configmap (services restart, but still on `meza.chat`)
3. Create `app.meza.chat` and `api.meza.chat` DNS records pointing to server
4. Test `app.meza.chat` and `api.meza.chat` work correctly
5. Connect Cloudflare Pages and add `meza.chat` custom domain
6. Switch `meza.chat` DNS to Cloudflare Pages
7. Verify everything, restore TTLs
