# Atlas AI — Backend Architecture (`atlas-ai-api`)

This is the architectural source of truth for the backend. It covers structure, conventions, and the reasoning behind them — not just "what," but "why," so decisions don't get silently reversed later.

---

## 1. What This Backend Is

`atlas-ai-api` is a single Express.js + TypeScript backend serving **two client applications**:

- **Mobile app** (Flutter) — `atlas-ai-mobile`
- **Web app** (Next.js) — `atlas-ai-web`

Both are thin clients over the same REST API. Business logic, validation, and data access live exactly once, here — never duplicated per client. This is also a long-term personal engineering project: architectural quality and understanding the "why" behind each decision matter more than shipping speed.

---

## 2. Multi-Client Architecture

One backend, two clients, one contract:

- **API versioning**: all routes under `/api/v1/...`. A breaking change becomes `/api/v2/...`, never a silent behavior change under an existing client.
- **Response envelope**: identical for both clients — `{ success, data, meta }` on success, `{ success: false, error }` on failure. No client-specific response shaping anywhere in the codebase.
- **CORS**: mobile (native) doesn't hit CORS; the web app's origin is explicitly whitelisted via `WEB_APP_ORIGIN`, `credentials: true` enabled only for that origin.

### Auth differs by client, safely

|                    | Mobile                                                         | Web                                                                                                                              |
| ------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Access token       | Bearer header                                                  | Bearer header (in-memory, not localStorage)                                                                                      |
| Refresh token      | Returned in response body → stored in `flutter_secure_storage` | Set as an `HttpOnly`, `Secure`, `SameSite=Strict` cookie                                                                         |
| Why the difference | No cookie jar equivalent on mobile                             | Cookie protects the refresh token from any XSS-readable JS access — strictly safer than body-delivery when a browser is involved |

**This is not two separate auth systems.** `AuthService` has one login/refresh/logout implementation. The only difference is in the controller layer: it detects the requesting client (a `X-Client` header or similar, set by each app) and decides whether to also set a cookie on top of the JSON body. Business logic — password verification, token signing, rotation — is identical and untouched by which client is calling.

**Non-negotiable:** frontend redirects or client-side state are never treated as proof of anything server-side. The backend is the single source of truth for auth state, payment state (later), and processing state — both clients just reflect it.

---

## 3. Domain Model

```
User
 └── Workspace
      └── Project
           └── Document
```

Workspace membership starts single-owner but the schema must not preclude multi-member workspaces later. See `prisma/schema.prisma` for the authoritative shape.

---

## 4. Architectural Style: Feature-Based (Vertical Slice)

Code is organized by **domain feature**, not by technical layer. Each feature owns its full stack.

```
src/
  features/
    auth/
      auth.controller.ts     # HTTP layer — no business logic
      auth.service.ts         # Business logic — the feature's public API
      auth.module.ts            # Composition root — manual DI wiring, exports the router
      auth.repository.ts          # The only file here allowed to import Prisma
      dto/                          # zod schemas + request/response types
        login.dto.ts
        register.dto.ts
        refresh.dto.ts
      guards/                        # Feature-specific guards, if any (rare)
      types/                          # Types internal to this feature
    workspace/
      ... same shape
    project/
      ... same shape
    document/
      ... same shape
  shared/
    guards/            # Cross-cutting guards (e.g. auth.guard.ts) used by every feature
    interceptors/        # Response shaping, logging — applied globally or per-router
    middleware/            # Validation middleware, error handler
    errors/                  # Base + specific error classes
    config/                    # Environment parsing/validation
    database/                    # Single Prisma client instance
    utils/                          # Hashing, token signing, logger, etc.
  app.ts                              # Express app assembly — mounts every feature's router
  server.ts                             # Bootstrap/listen
prisma/
  schema.prisma
  migrations/
```

### Why feature-based, not global layers

Atlas AI's domain shape (User → Workspace → Project → Document, plus RAG, agents, payments arriving later) maps naturally onto feature folders — each new capability is a new `features/` folder, not new files scattered across five global directories.

### Cross-feature dependency rule

**A feature may import another feature's `.service.ts`. It may never import another feature's `.repository.ts`, `dto/`, or internal `types/`.**

This is the rule that keeps feature-based architecture from decaying into an unstructured folder-per-domain layout. Example: once `document` needs to check project ownership, `document.service.ts` calls `projectService.getById(...)` — it never imports `project.repository.ts` directly. This keeps each feature's persistence layer private and preserves the "swap the DB layer without touching business logic" property.

---

## 5. Dependency Injection (Manual, No Container)

There's no NestJS-style DI container here — Express doesn't have one, and building one would be reinventing Nest badly. Instead, each feature's `.module.ts` is a **composition root**: a plain file that manually constructs the dependency graph via constructor injection, then exports a configured router.

```typescript
/**
 * @file auth.module.ts
 * @description Composition root for the Auth feature. Wires repository -> service ->
 * controller manually (no DI container) and exports a configured Express Router.
 */
import { Router } from 'express';
import { prisma } from '../../shared/database/prisma';
import { validateBody } from '../../shared/middleware/validate';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { loginSchema, registerSchema, refreshSchema } from './dto';

const authRepository = new AuthRepository(prisma);
const authService = new AuthService(authRepository);
const authController = new AuthController(authService);

export const authRouter = Router();

authRouter.post('/register', validateBody(registerSchema), authController.register);
authRouter.post('/login', validateBody(loginSchema), authController.login);
authRouter.post('/refresh', validateBody(refreshSchema), authController.refresh);
authRouter.post('/logout', authController.logout);
```

This gets ~90% of what a DI container buys you — testability via constructor injection, swappable implementations, an explicit dependency graph — without decorators or reflection metadata.

### Mapping Nest vocabulary onto this Express structure

| NestJS concept             | This repo's equivalent                                            |
| -------------------------- | ----------------------------------------------------------------- |
| `@Module()`                | `<feature>.module.ts` (composition root, not a runtime construct) |
| Guard                      | `shared/guards/*.guard.ts` — Express middleware                   |
| Pipe                       | `shared/middleware/validate.ts` — zod validation middleware       |
| Interceptor                | `shared/interceptors/*.ts` — response-shaping middleware          |
| Exception Filter           | Centralized error-handling middleware                             |
| Provider / `@Injectable()` | A plain class, wired manually in `.module.ts`                     |

---

## 6. Reference Implementation — Auth Feature

Full example showing every file type and how they connect.

**`dto/login.dto.ts`**

```typescript
/**
 * @file login.dto.ts
 * @description Request contract for POST /auth/login.
 */
import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export type LoginDto = z.infer<typeof loginSchema>;
```

**`auth.repository.ts`**

```typescript
/**
 * @file auth.repository.ts
 * @description The only file in the auth feature allowed to import the Prisma client
 * directly. All persistence for auth-related data lives here.
 */
import { PrismaClient, User } from '@prisma/client';

export class AuthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Finds a user by email.
   * @param email - The user's email address.
   * @returns The user record, or null if no user exists with that email.
   */
  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  /**
   * Persists a newly issued refresh token for a user.
   */
  async storeRefreshToken(userId: string, token: string): Promise<void> {
    await this.prisma.refreshToken.create({ data: { userId, token } });
  }
}
```

**`auth.service.ts`**

```typescript
/**
 * @file auth.service.ts
 * @description Business logic for authentication: password verification, token
 * issuance, and refresh-token rotation. Framework-agnostic — no Express types here.
 */
import { AuthRepository } from './auth.repository';
import { LoginDto } from './dto';
import { InvalidCredentialsError } from '../../shared/errors';
import { verifyPassword } from '../../shared/utils/hash';
import { signAccessToken, signRefreshToken } from '../../shared/utils/tokens';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export class AuthService {
  constructor(private readonly authRepository: AuthRepository) {}

  /**
   * Verifies credentials and issues a new access/refresh token pair.
   * @param dto - Validated login payload.
   * @throws {InvalidCredentialsError} If the email/password combination is invalid.
   */
  async login(dto: LoginDto): Promise<TokenPair> {
    const user = await this.authRepository.findByEmail(dto.email);
    if (!user || !(await verifyPassword(dto.password, user.passwordHash))) {
      throw new InvalidCredentialsError();
    }

    const accessToken = signAccessToken(user.id);
    const refreshToken = signRefreshToken(user.id);
    await this.authRepository.storeRefreshToken(user.id, refreshToken);

    return { accessToken, refreshToken };
  }
}
```

**`auth.controller.ts`**

```typescript
/**
 * @file auth.controller.ts
 * @description HTTP layer for authentication endpoints. Translates HTTP requests into
 * AuthService calls and shapes responses. Contains no business logic or direct Prisma access.
 */
import { Request, Response, NextFunction } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto';

export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /**
   * Handles POST /auth/login. Sets a refresh-token cookie for web clients;
   * mobile clients receive the refresh token in the JSON body only.
   */
  login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const dto = req.body as LoginDto;
      const { accessToken, refreshToken } = await this.authService.login(dto);

      if (req.headers['x-client'] === 'web') {
        res.cookie('refreshToken', refreshToken, {
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
        });
      }

      res.status(200).json({ accessToken, refreshToken });
    } catch (error) {
      next(error);
    }
  };
}
```

**`shared/guards/auth.guard.ts`**

```typescript
/**
 * @file auth.guard.ts
 * @description Express middleware that verifies the Bearer access token on protected
 * routes and attaches the authenticated user to the request. Equivalent to a NestJS Guard.
 */
import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../utils/tokens';
import { UnauthorizedError } from '../errors';

export function authGuard(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new UnauthorizedError();
  }

  const token = header.slice(7);
  req.user = verifyAccessToken(token); // throws if invalid/expired
  next();
}
```

**`shared/interceptors/response.interceptor.ts`**

```typescript
/**
 * @file response.interceptor.ts
 * @description Wraps every successful JSON response in the standard { success, data }
 * envelope so controllers never shape it manually. Equivalent to a NestJS Interceptor.
 */
import { Request, Response, NextFunction } from 'express';

export function responseEnvelope(_req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => originalJson({ success: true, data: body });
  next();
}
```

**`shared/middleware/validate.ts`**

```typescript
/**
 * @file validate.ts
 * @description Generic zod-validation middleware factory. Equivalent to a NestJS Pipe —
 * validates req.body against a schema before the request reaches a controller.
 */
import { Request, Response, NextFunction } from 'express';
import { ZodSchema } from 'zod';
import { ValidationError } from '../errors';

export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      throw new ValidationError(result.error.issues);
    }
    req.body = result.data;
    next();
  };
}
```

---

## 7. Strict Engineering Rules

These are enforced, not suggested. A PR/change that violates one of these should be flagged and fixed, not merged with a "TODO."

1. **No `any`.** Use `unknown` with narrowing, a precise type, or a generic. If genuinely unavoidable, it needs an inline comment explaining why — a bare `any` is never acceptable.
2. **Modular, single-responsibility files.** One class or one concern per file. No god-files, no files that grow to do "everything for this feature."
3. **Clean code.** Small functions, descriptive names over comments explaining "what," no dead code, no commented-out code left in commits.
4. **TSDoc required** — at the top of every file (`@file`, `@description`) and on every exported class, function, and type. This is for future-you (and future Claude) to understand intent without reading the full implementation.
5. **Strict TypeScript compiler settings**, enforced not just by convention: `strict: true`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`.
6. **No direct Prisma access outside a feature's `.repository.ts`.**
7. **No cross-feature imports** except another feature's `.service.ts` (§4).
8. **No business logic in controllers or routes** — controllers only translate HTTP ↔ service calls.
9. **Every route input validated via a zod DTO** before reaching a controller — no untyped `req.body`/`req.query`/`req.params` anywhere.
10. **Centralized error handling.** Throw typed custom error classes (`shared/errors/`), never raw strings or generic `Error`. One error-handling middleware maps them to HTTP responses.
11. **No magic strings or numbers.** Named constants or enums.
12. **No `console.log`.** Use the shared structured logger (`shared/utils/logger.ts`) — needed for real observability later (Phase 9), and bad habits are hard to unlearn once the codebase is large.
13. **Environment variables validated at startup**, fail-fast, via a single zod-parsed config module (`shared/config/`). Never read `process.env.X` ad hoc inside business logic.
14. **Consistent response envelope** enforced via the shared interceptor (§6) — never shaped manually per controller.
15. **Document thrown errors** in TSDoc (`@throws`) on any exported function that can fail.
16. **Secrets never hardcoded** — always sourced from the validated config module.

---

## 8. Authentication Architecture (detail)

Built from scratch (not an auth-as-a-service provider) for learning purposes.

```
Client → Access Token (short-lived JWT) → API → Auth Guard → Controller → Service
```

- Argon2 for password hashing.
- Short-lived access tokens (~15m) + long-lived refresh tokens (~30d), rotated on every use — old refresh token invalidated the moment a new one is issued.
- Mobile: both tokens delivered in the response body; refresh token stored in `flutter_secure_storage`.
- Web: access token in body (held in memory by the client, not localStorage); refresh token additionally set as an `HttpOnly`/`Secure`/`SameSite=Strict` cookie (§2).
- RBAC and workspace-scoped resource ownership checks layer on top of the base auth guard as additional guards.

---

## 9. Error Handling

All errors extend a base `AppError` class carrying an HTTP status code and a machine-readable code:

```typescript
/**
 * @file errors/app-error.ts
 * @description Base class for all typed application errors.
 */
export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
}

export class InvalidCredentialsError extends AppError {
  readonly statusCode = 401;
  readonly code = 'INVALID_CREDENTIALS';
  constructor() {
    super('Invalid email or password.');
  }
}
```

A single error-handling middleware at the end of the Express chain catches these, maps to the `{ success: false, error }` envelope, and logs unexpected (non-`AppError`) errors distinctly from expected ones.

---

## 10. Testing

- Test runner: **not yet finalized** (Jest vs. Vitest) — decide before Phase 2 auth work begins, don't default silently.
- Service-layer logic gets unit tests with repositories mocked via their constructor-injected interface.
- Repository-layer tests run against a real Dockerized test database rather than mocking Prisma — realistic behavior over heavily mocked tests.

---

## 11. Roadmap

| Phase | Focus                                                                                      |
| ----- | ------------------------------------------------------------------------------------------ |
| 1     | Foundation — Express, TS, Prisma, Docker Postgres, feature-based scaffold                  |
| 2     | Authentication — Argon2, access/refresh JWT, rotation, guards, mobile + web token delivery |
| 3     | Core domain — Workspaces, Projects, Documents, file uploads                                |
| 4     | RAG — extraction, chunking, embeddings, vector storage, retrieval, citations               |
| 5     | AI Agents — tool calling, multi-step workflows                                             |
| 6     | Background processing — queues, workers, retries                                           |
| 7     | Notifications — in-app, email                                                              |
| 8     | Stripe payments (test mode) — checkout, webhooks, idempotency                              |
| 9     | Infra — Docker multi-service, Nginx, Redis, observability                                  |
| 10+   | Open experimentation                                                                       |

---

## 12. Open Decisions

- [ ] Test runner — Jest vs. Vitest
- [ ] Exact `X-Client` header contract (name, values) for mobile vs. web detection in controllers
- [ ] Logging library (candidates: pino, winston)
