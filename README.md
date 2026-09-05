# Atlas AI — Backend API (`atlas-ai-api`)

Backend API for **Atlas AI** — a document organization and AI-search platform. This service is the single backend powering **both the Atlas AI mobile app (Flutter)** and the **Atlas AI web app (Next.js)**. Both clients consume the same REST API; there is no separate backend-for-frontend per platform.

See [`PROJECT.md`](./PROJECT.md) for full architecture, folder structure, and coding standards. See [`CLAUDE.md`](./CLAUDE.md) for how AI coding assistants should operate in this repo.

---

## Tech Stack

| Layer      | Technology                                            |
| ---------- | ----------------------------------------------------- |
| Runtime    | Node.js + TypeScript (strict mode)                    |
| Framework  | Express.js                                            |
| ORM        | Prisma                                                |
| Database   | PostgreSQL (Docker, local dev)                        |
| Validation | zod                                                   |
| Auth       | Argon2 (hashing) + JWT (access/refresh, custom-built) |
| Logging    | Shared structured logger (no `console.log`)           |

---

## Clients

| Client               | Repo              | Auth mechanism                                               |
| -------------------- | ----------------- | ------------------------------------------------------------ |
| Mobile app (Flutter) | `atlas-ai-mobile` | Bearer access token + refresh token in secure device storage |
| Web app (Next.js)    | `atlas-ai-web`    | Bearer access token + refresh token via HTTP-only cookie     |

Both clients hit the same versioned endpoints (`/api/v1/...`) and receive the same response envelope. See `PROJECT.md` § Multi-Client Architecture for how auth differs safely between the two without duplicating backend logic.

---

## Prerequisites

- Node.js (LTS)
- Docker + Docker Compose
- npm

---

## Setup

```bash
# 1. Clone
git clone <repo-url> atlas-ai-api
cd atlas-ai-api

# 2. Install dependencies
npm install

# 3. Copy environment variables
cp .env.example .env
# fill in required values — see "Environment Variables" below

# 4. Start PostgreSQL in Docker
docker compose up -d postgres

# 5. Run Prisma migrations
npx prisma migrate dev

# 6. Start the dev server
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

All environment variables are validated at startup (fail-fast) — the server refuses to boot if required variables are missing or malformed. See `PROJECT.md` § Configuration.

---

## Project Structure (summary)

```
src/
    auth/
      auth.controller.ts
      auth.service.ts
      auth.module.ts
      auth.repository.ts
      dto/
      guards/
      types/
  shared/            # Cross-cutting: guards, interceptors, middleware, errors, config
prisma/
  schema.prisma
```

Full explanation of every file's responsibility, the dependency-injection pattern, and cross-feature import rules: see `PROJECT.md`.

---

## Scripts

```bash
npm run start:dev            # Start dev server with hot reload
npm run build           # Compile TypeScript
npm run start             # Run compiled build
npm run prisma:studio     # Open Prisma Studio
npm run test               # Run test suite
npm run lint                # Lint
npm run typecheck            # Type-check without emitting
```

---

## Status

Currently in **Phase 1 — Foundation**. See `PROJECT.md` § Roadmap for the full phase plan.
