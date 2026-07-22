# Technical Context: Next.js Starter Template

## Current Production Baseline (2026-07-22)

- Next.js 15.5.18, React 19.2.0, TypeScript 5.9, Tailwind CSS 3.4.
- pnpm 10.28.1 is the only release package manager; Node 22 is the canonical runtime.
- Kilo production is bundled with `@opennextjs/cloudflare` 1.20.1 and Wrangler 4.86.0.
- Runtime state uses shared Redis when configured, otherwise a fail-closed InlineLocalRedis paper fallback. Kilo's managed `DB_URL`/`DB_TOKEN` HTTP SQLite store is accessed through the local, registry-only `lib/kilo-database-client.ts` adapter and provides revision-CAS persistence plus cross-worker request leases. `vendor/app-builder-db-marker` retains Kilo App Builder's dependency-name provisioning signal without importing the Git-hosted client at runtime.
- Kilo Deploy autobuilds the linked GitHub `main` branch and supports deployment environment variables/secrets, but does not provide a built-in database. Configure a reachable external shared Redis (`REDIS_URL`/Upstash REST/KV) for Kilo Workers; localhost Redis is only for the installed long-lived server. Repository cron metadata is not assumed to survive the Kilo upload; the Worker scheduled handler remains canonical and an open-dashboard paper-only pulse is the bounded fallback.
- Real exchange orders require the canonical infrastructure and credential safety gates; validation must never place a real order unless the operator explicitly authorizes the live smoke prerequisites.

## Technology Stack

| Technology   | Version | Purpose                         |
| ------------ | ------- | ------------------------------- |
| Next.js      | 16.x    | React framework with App Router |
| React        | 19.x    | UI library                      |
| TypeScript   | 5.9.x   | Type-safe JavaScript            |
| Tailwind CSS | 4.x     | Utility-first CSS               |
| Bun          | Latest  | Package manager & runtime       |

## Development Environment

### Prerequisites

- Bun installed (`curl -fsSL https://bun.sh/install | bash`)
- Node.js 20+ (for compatibility)

### Commands

```bash
bun install        # Install dependencies
bun dev            # Start dev server (http://localhost:3000)
bun build          # Production build
bun start          # Start production server
bun lint           # Run ESLint
bun typecheck      # Run TypeScript type checking
```

## Project Configuration

### Next.js Config (`next.config.ts`)

- App Router enabled
- Default settings for flexibility

### TypeScript Config (`tsconfig.json`)

- Strict mode enabled
- Path alias: `@/*` → `src/*`
- Target: ESNext

### Tailwind CSS 4 (`postcss.config.mjs`)

- Uses `@tailwindcss/postcss` plugin
- CSS-first configuration (v4 style)

### ESLint (`eslint.config.mjs`)

- Uses `eslint-config-next`
- Flat config format

## Key Dependencies

### Production Dependencies

```json
{
  "next": "^16.1.3", // Framework
  "react": "^19.2.3", // UI library
  "react-dom": "^19.2.3" // React DOM
}
```

### Dev Dependencies

```json
{
  "typescript": "^5.9.3",
  "@types/node": "^24.10.2",
  "@types/react": "^19.2.7",
  "@types/react-dom": "^19.2.3",
  "@tailwindcss/postcss": "^4.1.17",
  "tailwindcss": "^4.1.17",
  "eslint": "^9.39.1",
  "eslint-config-next": "^16.0.0"
}
```

## File Structure

```
/
├── .gitignore              # Git ignore rules
├── package.json            # Dependencies and scripts
├── bun.lock                # Bun lockfile
├── next.config.ts          # Next.js configuration
├── tsconfig.json           # TypeScript configuration
├── postcss.config.mjs      # PostCSS (Tailwind) config
├── eslint.config.mjs       # ESLint configuration
├── public/                 # Static assets
│   └── .gitkeep
└── src/                    # Source code
    └── app/                # Next.js App Router
        ├── layout.tsx      # Root layout
        ├── page.tsx        # Home page
        ├── globals.css     # Global styles
        └── favicon.ico     # Site icon
```

## Technical Constraints

### Starting Point

- Minimal structure - expand as needed
- No database by default (use recipe to add)
- No authentication by default (add when needed)

### Browser Support

- Modern browsers (ES2020+)
- No IE11 support

## Performance Considerations

### Image Optimization

- Use Next.js `Image` component for optimization
- Place images in `public/` directory

### Bundle Size

- Tree-shaking enabled by default
- Tailwind CSS purges unused styles

### Core Web Vitals

- Server Components reduce client JavaScript
- Streaming and Suspense for better UX

## Deployment

### Build Output

- Server-rendered pages by default
- Can be configured for static export

### Environment Variables

- None required for base template
- Add as needed for features
- Use `.env.local` for local development

### CTS Runtime Persistence

- Redis is the primary runtime/coordinator store. Production workers must share
  one backend through `REDIS_URL`, Upstash REST variables, or Vercel KV REST
  variables; the in-process adapter is development/demo-only and cannot release
  live exchange orders.
- Kilo's optional managed SQLite binding uses Drizzle ORM plus the typed HTTP
  adapter in `lib/kilo-database-client.ts` with server-only `DB_URL` and
  `DB_TOKEN`. Schema files live in `src/db/schema.ts` and generated SQL lives in
  `src/db/migrations/`.
- `pnpm run db:migrate` uses a deployment-aware wrapper. Vercel skips the
  Kilo-only step; Kilo launches `node --import tsx src/db/migrate.ts`, skips
  cleanly when the optional binding is absent, and applies Drizzle migrations
  when the binding is present.
- The dependency graph is locked with pnpm 10.28.1 and contains no Git-hosted
  runtime packages, keeping Vercel and Kilo clean installs deterministic.
