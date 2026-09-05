# Atlas AI — Backend API (`atlas-ai-api`)

Backend API for **Atlas AI** — a document organization and AI-search platform. Built with **NestJS**. This service is the single backend powering **both the Atlas AI mobile app (Flutter)** and the **Atlas AI web app (Next.js)**.

See [`docs/PROJECT.md`](./docs/PROJECT.md) for full architecture, module structure, and coding standards. See [`CLAUDE.md`](./CLAUDE.md) for how AI coding assistants should operate in this repo.

---

## Tech Stack

| Layer      | Technology                                                                 |
| ---------- | -------------------------------------------------------------------------- |
| Framework  | NestJS (TypeScript, strict mode)                                           |
| ORM        | Prisma                                                                     |
| Database   | PostgreSQL (Docker, local dev)                                             |
| Validation | class-validator + class-transformer (Nest `ValidationPipe`)                |
| Auth       | Argon2 (hashing) + JWT (access/refresh, hand-rolled Guards — not Passport) |
| Testing    | Jest (Nest's default)                                                      |

---

## Clients

| Client               | Repo              | Auth mechanism                                               |
| -------------------- | ----------------- | ------------------------------------------------------------ |
| Mobile app (Flutter) | `atlas-ai-mobile` | Bearer access token + refresh token in secure device storage |
| Web app (Next.js)    | `atlas-ai-web`    | Bearer access token + refresh token via HTTP-only cookie     |

---

## Prerequisites

- Node.js (LTS)
- Docker + Docker Compose
- `@nestjs/cli` (`npm i -g @nestjs/cli`, optional but useful for `nest generate`)

---

## Setup

```bash
git clone <repo-url> atlas-ai-api
cd atlas-ai-api
npm install
cp .env.example .env
docker compose up -d postgres
npx prisma migrate dev
npm run start:dev
```

API available at `http://localhost:<PORT>` (see `.env`).

---

## Environment Variables

| Variable             | Description                                  |
| -------------------- | -------------------------------------------- |
| `PORT`               | Port the API listens on                      |
| `DATABASE_URL`       | Postgres connection string (Prisma)          |
| `JWT_ACCESS_SECRET`  | Signing secret for short-lived access tokens |
| `JWT_REFRESH_SECRET` | Signing secret for refresh tokens            |
| `ACCESS_TOKEN_TTL`   | Access token expiry (e.g. `15m`)             |
| `REFRESH_TOKEN_TTL`  | Refresh token expiry (e.g. `30d`)            |
| `FRONTEND_URL`       | Allowed CORS origin for the web app          |
| `NODE_ENV`           | `development` \| `test` \| `production`      |

Validated at startup via Nest's `ConfigModule` — the app refuses to boot on missing/malformed config.

---

## Project Structure (summary)

```
src/
    <feature>.controller.ts
    <feature>.service.ts
    <feature>.repository.ts
    <feature>.module.ts
    dto/
  prisma/
    prisma.service.ts
    prisma.module.ts
  common/
    guards/  interceptors/  filters/  decorators/  exceptions/  config/
  app.module.ts
  main.ts
prisma/
  schema.prisma
```

Full detail: `docs/PROJECT.md`.

---

## Scripts

```bash
npm run start:dev     # Dev server, watch mode
npm run build          # nest build (prisma generate runs first via postinstall + build)
npm run start:prod       # Run compiled build (dist/main.js)
npm run test               # Unit tests (Jest)
npm run test:e2e             # End-to-end tests
npm run lint                  # Lint
```

---

## Status

Currently in **Phase 1 — Foundation**. See `docs/PROJECT.md` § Roadmap.
