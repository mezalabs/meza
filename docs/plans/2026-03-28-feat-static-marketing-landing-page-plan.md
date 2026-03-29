---
title: "feat: Static marketing landing page on Cloudflare Pages"
type: feat
status: active
date: 2026-03-28
---

# Static Marketing Landing Page

## Overview

Build a static marketing landing page for Meza using Astro, deployed on Cloudflare Pages at `meza.chat`. The existing React SPA moves to `app.meza.chat`, and API endpoints move to `api.meza.chat`. This gives unauthenticated visitors a fast, zero-JS (with minimal exception for OS detection) marketing experience while keeping the app and API cleanly separated on their own subdomains.

**Brainstorm document**: `docs/brainstorms/2026-03-28-landing-page-brainstorm.md`

## Problem Statement

Today, visiting `meza.chat` loads the full React SPA bundle (~300KB+ JS) just to show unauthenticated users a minimal landing page with a download button and "Continue in browser" link. This is slow, not SEO-friendly (JS-rendered content), and provides no marketing content to convince new visitors to try Meza.

## Proposed Solution

### Architecture

```
meza.chat          → Cloudflare Pages (Astro static site)
app.meza.chat      → Server (Caddy → SPA static files + reverse proxy)
api.meza.chat      → Server (Caddy → Go microservices via NATS)
```

**Astro project** at `client/packages/landing` in the monorepo. Pure static HTML/CSS output with a single minimal JS exception for OS-detected download buttons. Shares Tailwind v4 design tokens with the existing app for visual consistency.

### Subdomain Architecture

| Subdomain | Serves | Hosted On | Notes |
|-----------|--------|-----------|-------|
| `meza.chat` | Marketing landing page + privacy policy | Cloudflare Pages | Static, globally cached |
| `app.meza.chat` | React SPA (chat application) | Your server (Caddy) | Existing SPA, unchanged |
| `api.meza.chat` | Go microservices (gRPC-web, WebSocket) | Your server (Caddy) | New subdomain for API |

### Page Sections

1. **Hero** — Tagline, value proposition, primary CTA (download + open web app), 3D perspective app screenshot with scroll-driven animation
2. **Feature cards** — E2E encrypted, no tracking, open source, self-hostable
3. **FAQ** — Collapsible accordion using `<details>/<summary>` (zero JS)
4. **Final CTA** — Repeated call-to-action
5. **Footer** — Product links, resources, GitHub

### Pages

| Route | Content |
|-------|---------|
| `/` | Marketing landing page (all sections above) |
| `/privacy` | Privacy policy |

## Technical Approach

### Tech Stack

| Technology | Version | Purpose |
|------------|---------|---------|
| Astro | ^5.18.1 | Static site generator |
| Tailwind CSS | ^4.2.2 | Utility CSS with shared design tokens |
| `@tailwindcss/vite` | ^4.2.2 | Vite plugin for Tailwind v4 |
| `@astrojs/sitemap` | latest | Auto-generated sitemap |
| TypeScript | ^5.7.0 | Type checking |

### Project Structure

```
client/packages/landing/
├── astro.config.mjs
├── package.json
├── tsconfig.json
├── public/
│   ├── favicon.svg          # Copy from web/public/
│   ├── robots.txt
│   ├── _headers             # Cloudflare Pages security headers
│   └── og-image.png         # 1200x630 Open Graph image
├── src/
│   ├── styles/
│   │   └── global.css       # Tailwind v4 @theme tokens (shared with SPA)
│   ├── layouts/
│   │   └── Layout.astro     # Base HTML shell
│   ├── components/
│   │   ├── BaseHead.astro   # Meta tags, OG, structured data
│   │   ├── Header.astro     # Nav bar
│   │   ├── Footer.astro     # Footer links
│   │   └── sections/
│   │       ├── Hero.astro
│   │       ├── Features.astro
│   │       ├── FAQ.astro
│   │       └── FinalCTA.astro
│   ├── pages/
│   │   ├── index.astro      # Composes all sections
│   │   └── privacy.astro    # Privacy policy page
│   └── assets/
│       ├── images/           # Mockups, icons (processed by astro:assets)
│       └── fonts/            # Geist variable font files
└── wrangler.jsonc            # Optional: Cloudflare deploy config
```

### Design Token Sharing

The existing design system lives in `client/packages/web/src/index.css` as a Tailwind v4 `@theme {}` block. Extract the token definitions into the landing page's `global.css`:

**`client/packages/landing/src/styles/global.css`:**
```css
@import "tailwindcss";

@theme {
  /* Colors — dark theme */
  --color-bg-base: #121212;
  --color-bg-surface: #1b1b1b;
  --color-bg-elevated: #242424;
  --color-bg-overlay: #0f0f0f;

  --color-accent: #6affb0;
  --color-accent-hover: #92ffc2;
  --color-accent-muted: #4ea374;
  --color-accent-subtle: #234230;

  --color-text: #e8e8e8;
  --color-text-muted: #8f8f8f;
  --color-text-subtle: #555555;

  --color-border: #2e2e2e;
  --color-border-hover: #484848;

  /* Typography */
  --font-sans: "Geist Variable", "Geist", system-ui, -apple-system, sans-serif;
  --font-mono: "Geist Mono Variable", "Geist Mono", ui-monospace, monospace;

  --text-xs: 0.75rem;
  --text-sm: 0.8125rem;
  --text-base: 0.875rem;
  --text-lg: 1rem;
  --text-xl: 1.25rem;
  --text-2xl: 1.5rem;

  /* Border radii */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 20px;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.3);
  --shadow-md: 0 4px 8px rgb(0 0 0 / 0.4);
  --shadow-lg: 0 8px 24px rgb(0 0 0 / 0.5);

  /* Easing */
  --ease-snappy: cubic-bezier(0.2, 0, 0, 1);
  --ease-smooth: cubic-bezier(0.4, 0, 0.2, 1);
}
```

This duplicates the tokens rather than importing cross-package — simpler, no build coupling between landing and web packages.

### Astro Configuration

**`client/packages/landing/astro.config.mjs`:**
```js
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://meza.chat",
  output: "static",
  integrations: [sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
});
```

### Package Configuration

**`client/packages/landing/package.json`:**
```json
{
  "name": "@meza/landing",
  "type": "module",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "check": "astro check"
  },
  "dependencies": {
    "astro": "^5.18.1",
    "@astrojs/sitemap": "^3.2.1",
    "tailwindcss": "^4.2.2",
    "@tailwindcss/vite": "^4.2.2"
  },
  "devDependencies": {
    "typescript": "^5.7.0"
  }
}
```

No changes needed to `client/pnpm-workspace.yaml` — the `packages/*` glob auto-includes `packages/landing`.

### OS-Detected Download Button

A small inline `<script>` (~15 lines) detects the visitor's OS via `navigator.userAgent` and highlights the matching download button. All three platform buttons are visible in the HTML (macOS, Windows, Linux); the script adds a CSS class to emphasize the detected one. Graceful degradation: without JS, all buttons are equally visible.

The latest release version is fetched at **build time** from the GitHub API (`https://api.github.com/repos/mezalabs/meza/releases?per_page=1`) and baked into the HTML. This means a site rebuild is needed after each desktop release — Cloudflare Pages deploy hooks can automate this.

### SEO

**BaseHead.astro** includes:
- `<title>` (50-60 chars)
- `<meta name="description">` (120-160 chars)
- `<link rel="canonical">`
- Open Graph tags (og:title, og:description, og:image, og:url, og:type)
- Twitter Card tags (summary_large_image)
- JSON-LD structured data (`SoftwareApplication` schema)

**Other SEO files:**
- `public/robots.txt` — allows all crawlers, references sitemap
- `@astrojs/sitemap` generates `/sitemap-index.xml` at build time
- `app.meza.chat` SPA gets `<meta name="robots" content="noindex">` to prevent indexing

### Security Headers

**`public/_headers`** (Cloudflare Pages format):
```
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self' https://api.github.com
```

The `connect-src` allows the build-time GitHub API fetch (if ever moved to client-side) and the `script-src 'self'` permits the OS detection inline script (which Astro bundles as a file).

### Font Loading

Self-host Geist Variable font files in `src/assets/fonts/`. Preload the Latin subset of the regular weight in `BaseHead.astro`:

```html
<link rel="preload" href="/fonts/geist-variable-latin.woff2" as="font" type="font/woff2" crossorigin />
```

Use `font-display: swap` in `@font-face` declarations within `global.css`.

### Image Strategy

- Real app screenshot in Hero (`src/assets/images/app-screenshot.png`)
- Use Astro's `<Image>` component for automatic WebP/AVIF conversion and responsive `srcset`
- Hero image: `loading="eager"` (above the fold)
- OG image: static 1200x630 PNG in `public/og-image.png` (TODO)

## Implementation Phases

> **Phases 1-3 are self-contained** — build and iterate on the landing page design locally (`localhost:4321`) with no server, DNS, or infrastructure changes. Phases 4-6 handle deployment and migration separately.

---

### Phase 1: Project Scaffolding & Design Tokens (localhost only)

**Goal:** Get Astro running on localhost with the correct fonts, colors, and base layout.

**Tasks:**
- [x] Create `client/packages/landing/` directory structure
- [x] Create `package.json` with Astro + Tailwind dependencies — `client/packages/landing/package.json`
- [x] Create `astro.config.mjs` with Tailwind vite plugin and sitemap — `client/packages/landing/astro.config.mjs`
- [x] Create `tsconfig.json` extending Astro base — `client/packages/landing/tsconfig.json`
- [x] Create `src/styles/global.css` with shared `@theme` tokens — `client/packages/landing/src/styles/global.css`
- [x] Set up Geist font files in `src/assets/fonts/` — `client/packages/landing/src/assets/fonts/`
- [x] Copy `favicon.svg` to `public/` — `client/packages/landing/public/favicon.svg`
- [x] Create `Layout.astro` base layout with font preloading — `client/packages/landing/src/layouts/Layout.astro`
- [x] Create `BaseHead.astro` with meta tags, OG, JSON-LD — `client/packages/landing/src/components/BaseHead.astro`
- [x] Create a minimal `index.astro` that renders a "Hello Meza" page using the layout — `client/packages/landing/src/pages/index.astro`
- [x] Verify `pnpm install` works and `pnpm --filter @meza/landing dev` starts Astro dev server on `localhost:4321`
- [x] Add `dev:landing` and `build:landing` tasks to root `Taskfile.yml`

**Success criteria:** `pnpm --filter @meza/landing dev` opens `localhost:4321` showing a page with correct Geist fonts, dark background (#121212), mint accent (#6affb0), and Meza favicon.

**No infrastructure changes.** No DNS, no Caddy, no server config.

---

### Phase 2: Landing Page Design & Content (localhost only)

**Goal:** Build all visual sections of the landing page. This is where most design iteration happens.

**Tasks:**
- [x] Create `Header.astro` — nav bar with Meza logo, "Open App" link, download CTA
- [x] Create `Hero.astro` — headline, subheadline, primary CTAs, 3D perspective app screenshot with scroll-driven swing animation
- [x] Create `Features.astro` — 4-card grid (E2E encrypted, no tracking, open source, self-hostable)
- [x] Create `FAQ.astro` — collapsible accordion with `<details>/<summary>` (zero JS)
- [x] Create `FinalCTA.astro` — repeated call-to-action at bottom
- [x] Create `Footer.astro` — product links, resources, GitHub
- [x] Compose all sections in `index.astro`
- [x] Implement OS detection + download dropdown in Hero
- [x] Real app screenshot in Hero (`src/assets/images/app-screenshot.png`)
- [x] Ensure responsive layout works on mobile viewports
- [x] Add `prefers-reduced-motion` support for scroll animation

**Success criteria:** Full landing page visible at `localhost:4321` with all sections. Download buttons detect user's OS. FAQ accordion works. Responsive on mobile.

**Removed during iteration:** Comparison table and AppMockups sections were cut — the hero screenshot and feature cards convey the product better without the clutter.

**No infrastructure changes.** Links point to placeholder URLs that will be updated in Phase 4.

---

### Phase 3: Privacy Policy, SEO & Build Verification (localhost only)

**Goal:** Complete all content pages and verify the static build output is production-ready.

**Tasks:**
- [x] Create `privacy.astro` page — `client/packages/landing/src/pages/privacy.astro`
- [x] Draft privacy policy content (or placeholder)
- [x] Create `public/robots.txt` with sitemap reference — `client/packages/landing/public/robots.txt`
- [x] Verify `@astrojs/sitemap` generates sitemap at build time
- [ ] Create OG image (1200x630) — `client/packages/landing/public/og-image.png` (placeholder OK)
- [x] Add JSON-LD structured data (`SoftwareApplication`) to `BaseHead.astro`
- [x] Create `public/_headers` with security headers — `client/packages/landing/public/_headers`
- [x] Create `src/pages/404.astro` — branded 404 page
- [x] Verify all images use Astro's `<Image>` component with WebP/AVIF
- [x] Run `pnpm --filter @meza/landing build` and inspect `dist/` output
- [ ] Run `pnpm --filter @meza/landing preview` to test the production build locally
- [ ] Performance audit with Lighthouse on localhost

**Success criteria:** `astro build` produces a clean `dist/` directory with HTML, CSS, optimized images, sitemap, robots.txt, security headers, and zero JS files (except the bundled OS detection script). Lighthouse 95+ on localhost.

**No infrastructure changes.** The build output is ready to deploy but deployment happens in Phase 5.

---

### Phase 4: Server & SPA Configuration (infrastructure)

**Goal:** Prepare the server to host the SPA at `app.meza.chat` and API at `api.meza.chat`.

**Tasks:**
- [ ] Update Caddyfile/Traefik ingress to add `app.meza.chat` and `api.meza.chat` routing — see `docs/plans/2026-03-29-infra-subdomain-split-plan.md`
- [ ] Update `MEZA_ALLOWED_ORIGINS` to include `https://app.meza.chat` — infra repo configmap
- [x] Update SPA's API base URL configuration — `getBaseUrl()` now uses `VITE_API_URL` for all platforms, set at build time
- [x] Add `<meta name="robots" content="noindex">` to `client/packages/web/index.html`
- [x] Add `<link rel="canonical" href="https://meza.chat">` to `client/packages/web/index.html`
- [ ] Test SPA works at `app.meza.chat` with API at `api.meza.chat` locally (hosts file or local DNS)
- [x] Create service worker unregister file at `public/sw-push.js` on the landing page

**Success criteria:** SPA works at `app.meza.chat`, API accessible at `api.meza.chat`, WebSocket connections succeed. Old `meza.chat` service worker is cleaned up.

---

### Phase 5: Cloudflare Pages Deployment & DNS Cutover (infrastructure)

**Goal:** Deploy the landing page to Cloudflare Pages and switch DNS.

**Tasks:**
- [ ] Connect repo to Cloudflare Pages (dashboard or `wrangler.jsonc`)
- [ ] Configure build settings: root `client/packages/landing`, build command `pnpm build`, output `dist`
- [ ] Add custom domain `meza.chat` to Cloudflare Pages project
- [ ] Configure build watch paths: `client/packages/landing/**` only
- [ ] Lower DNS TTL for `meza.chat` ahead of cutover (e.g., 60s)
- [ ] Create DNS records: `app.meza.chat` CNAME/A to server, `api.meza.chat` CNAME/A to server
- [ ] Switch `meza.chat` DNS from server to Cloudflare Pages
- [ ] Verify landing page loads at `meza.chat`
- [ ] Verify SPA loads at `app.meza.chat`
- [ ] Verify API works at `api.meza.chat`
- [ ] Restore DNS TTL to normal (3600s)
- [ ] Set up Cloudflare Pages deploy hook for automated rebuilds after desktop releases

**Success criteria:** `meza.chat` serves the Astro landing page globally via Cloudflare CDN. `app.meza.chat` and `api.meza.chat` function correctly. Deploy previews work for PRs.

---

### Phase 6: CI & Polish

**Goal:** Integrate with CI and final quality checks.

**Tasks:**
- [ ] Add landing page build/check to CI pipeline — update `.github/workflows/ci.yml`
- [ ] Or: rely on Cloudflare Pages native git integration for deploy previews (simpler)
- [ ] Test all pages on mobile devices
- [ ] Test accessibility: keyboard navigation, screen reader, color contrast (WCAG 2.1 AA)
- [ ] Performance audit: Lighthouse score target 95+ on all categories
**Success criteria:** CI passes, Lighthouse 95+, accessible, responsive on mobile.

## Acceptance Criteria

### Functional Requirements

- [ ] `meza.chat` serves a static marketing landing page with hero, features, FAQ, CTA, and footer
- [ ] `meza.chat/privacy` serves a privacy policy page
- [ ] Download buttons display for macOS, Windows, and Linux with OS detection highlighting the user's platform
- [ ] "Open Web App" CTA links to `app.meza.chat`
- [ ] FAQ accordion works with zero JavaScript (`<details>/<summary>`)
- [ ] All links (GitHub, privacy, downloads, app) work correctly
- [ ] `app.meza.chat` serves the existing React SPA
- [ ] `api.meza.chat` serves the Go microservices (gRPC-web, WebSocket)

### Non-Functional Requirements

- [ ] Minimal JavaScript: OS detection, download dropdown, scroll-driven hero animation
- [ ] Lighthouse Performance score >= 95
- [ ] Lighthouse Accessibility score >= 95
- [ ] Lighthouse SEO score >= 95
- [ ] WCAG 2.1 AA compliant
- [ ] Page weight under 500KB (including images)
- [ ] Time to First Contentful Paint < 1s on 4G
- [ ] OG tags render correctly on Twitter, Discord, Slack
- [ ] `sitemap-index.xml` and `robots.txt` present
- [ ] Security headers set via `_headers` file
- [ ] Dark theme only, matching the app's visual identity

### Quality Gates

- [ ] `astro build` succeeds with zero warnings
- [ ] `astro check` passes TypeScript checks
- [ ] All images optimized (WebP/AVIF via astro:assets)
- [ ] Fonts self-hosted with `font-display: swap`
- [ ] No external requests except GitHub API (build-time only)

## Dependencies & Prerequisites

| Dependency | Status | Notes |
|------------|--------|-------|
| Cloudflare account with Pages access | Required | Already managing DNS |
| `meza.chat` DNS on Cloudflare | Ready | Already configured |
| Server DNS records for `app.` and `api.` subdomains | Needed | New CNAME/A records |
| Caddyfile updates for new subdomains | Needed | New server blocks |
| OG image design (1200x630) | Needed | Can use placeholder initially |
| App mockup images | Done | Real screenshot in Hero |
| Privacy policy content | Needed | Legal review may be required |
| SPA API base URL configurable | Needed | Must support `api.meza.chat` |

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| DNS cutover causes downtime | Medium | High | Lower TTL before switch, test with preview deploy, have rollback plan (revert DNS) |
| Stale service worker serves cached SPA at meza.chat | Medium | Medium | Ship unregister service worker at same path on landing page |
| Download URLs become stale after release | High | Low | Cloudflare deploy hook triggers rebuild after each `desktop-v*` release |
| SPA CORS issues with new API subdomain | Medium | High | Test thoroughly before DNS cutover, update `MEZA_ALLOWED_ORIGINS` |

## Future Considerations

- **Blog**: Astro content collections make it easy to add a `/blog` section later
- **Documentation**: Self-hosting guide, API docs could be added as Astro pages
- **Internationalization**: Astro has built-in i18n routing support
- **Analytics**: Cloudflare Pages provides server-side analytics (no JS needed)
- **Invite link redirects**: Add `_redirects` file when needed for `/invite/*` migration
- **App store links**: Add iOS App Store and Google Play badges to mobile-detected CTAs

## References & Research

### Internal References

- Current landing page: `client/packages/ui/src/components/lobby/WebLandingPage.tsx`
- Feature cards copy: `client/packages/ui/src/components/lobby/FeatureCards.tsx`
- Download button logic: `client/packages/ui/src/components/lobby/DownloadButton.tsx`
- SVG logo: `client/packages/ui/src/components/lobby/MezaLogo.tsx`
- Design tokens: `client/packages/web/src/index.css` (lines 13-158, `@theme` block)
- Favicon: `client/packages/web/public/favicon.svg`
- Workspace config: `client/pnpm-workspace.yaml`
- Server config: `server/internal/config/config.go`
- Caddyfile: `deploy/Caddyfile`
- CI pipeline: `.github/workflows/ci.yml`
- Docker client build: `deploy/docker/Dockerfile.client`
- Brainstorm: `docs/brainstorms/2026-03-28-landing-page-brainstorm.md`

### External References

- [Astro documentation](https://docs.astro.build)
- [Deploy Astro to Cloudflare Pages](https://docs.astro.build/en/guides/deploy/cloudflare/)
- [Tailwind CSS v4 theme configuration](https://tailwindcss.com/docs/theme)
- [Install Tailwind with Astro](https://tailwindcss.com/docs/installation/framework-guides/astro)
- [Cloudflare Pages monorepo configuration](https://developers.cloudflare.com/pages/configuration/monorepos/)
- [Cloudflare Pages headers](https://developers.cloudflare.com/pages/configuration/headers/)
