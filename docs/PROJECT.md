# Atlas AI — Backend Architecture (`atlas-ai-api`, NestJS)

Architectural source of truth. Covers real NestJS structure — not the earlier Express-mimicking-Nest version this replaces.

---

## 1. What This Backend Is

A NestJS + TypeScript backend serving two clients: the **mobile app** (Flutter) and the **web app** (Next.js). Business logic, validation, and data access live exactly once, here. Also a long-term personal engineering project — understanding _why_, not just shipping fast, still matters.

---

## 2. Multi-Client Architecture

- **Versioning:** all routes under `/api/v1/...` (Nest's built-in URI versioning, `app.enableVersioning()`).
- **Response envelope:** `{ success, data, meta }` / `{ success: false, error }`, applied globally by `ResponseInterceptor` — controllers return plain data, never shape the envelope themselves.
- **CORS:** web app's origin explicitly whitelisted via `WEB_APP_ORIGIN`, `credentials: true` for that origin only. Mobile (native) isn't subject to CORS.

### Auth differs by client, same underlying service

|               | Mobile                                      | Web                                              |
| ------------- | ------------------------------------------- | ------------------------------------------------ |
| Access token  | Bearer header                               | Bearer header (in-memory client-side)            |
| Refresh token | Returned in body → `flutter_secure_storage` | `HttpOnly` + `Secure` + `SameSite=Strict` cookie |

One `AuthService`, one implementation. Only the controller checks an `X-Client` header to decide whether to also set a cookie. Never treat a frontend redirect or client state as proof of anything server-side — the backend is authoritative for auth/payment/processing state.

---

## 3. Domain Model

```
User → Workspace → Project → Document
```

Workspace membership starts single-owner; schema must not preclude multi-member later.

---

## 4. Module Structure

One Nest module per domain feature:

```
src/
  auth/
    auth.controller.ts
    auth.service.ts
    auth.repository.ts
    auth.module.ts
    dto/
      login.dto.ts
      register.dto.ts
    guards/
      jwt-auth.guard.ts
    auth.controller.spec.ts
    auth.service.spec.ts
  workspace/   project/   document/   # same shape
  prisma/
    prisma.service.ts    # extends PrismaClient with a required driver adapter (Prisma 7)
    prisma.module.ts      # @Global() — exported once, injectable everywhere
  common/
    guards/          # e.g. base JwtAuthGuard applied globally
    interceptors/      # ResponseInterceptor
    filters/             # HttpExceptionFilter
    exceptions/            # Custom exceptions extending HttpException
    decorators/              # @CurrentUser(), @Public()
    config/                    # env validation
  app.module.ts
  main.ts
```

### Why keep a `.repository.ts` layer (deviation from default Nest+Prisma tutorials)

Most Nest+Prisma guides inject `PrismaService` directly into the service. This repo keeps a thin repository per feature instead — one extra file, in exchange for: services stay swappable/testable without mocking the whole Prisma client, and persistence stays isolated the same way it was in the original architecture. **Cross-feature rule still applies:** a feature may import another feature's `.service.ts`, never its `.repository.ts`, `dto/`, or internal types.

---

## 5. Dependency Injection

Real Nest DI — no manual wiring. `@Module()` declares what's available; Nest's container resolves constructor parameters automatically via `reflect-metadata`.

```typescript
/**
 * @file auth.module.ts
 * @description Auth feature module — declares what's available to Nest's DI container.
 */
import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRepository } from './auth.repository';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthRepository],
  exports: [AuthService], // only the service is exposed to other modules
})
export class AuthModule {}
```

---

## 6. Reference Implementation — Auth Feature

**`dto/login.dto.ts`** — **using zod, not class-validator** (see note below)

```typescript
/**
 * @file login.dto.ts
 * @description Request contract for POST /auth/login. Validated by ZodValidationPipe
 * before reaching the controller.
 */
import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export type LoginDto = z.infer<typeof loginSchema>;
```

**`common/pipes/zod-validation.pipe.ts`**

```typescript
/**
 * @file zod-validation.pipe.ts
 * @description Generic zod-validation pipe. Applied per-route via @UsePipes(new
 * ZodValidationPipe(schema)) — the Nest equivalent of the global class-validator
 * ValidationPipe, but backed by zod schemas instead.
 */
import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import { ZodSchema } from 'zod';

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.issues);
    }
    return result.data;
  }
}
```

> **Correction from an earlier version of this doc:** this section originally used `class-validator` decorators, on the assumption that it's "idiomatic Nest." Your actual `package.json` has `zod` but no `class-validator`/`class-transformer` — so this was never actually your intent, and the earlier example wouldn't have compiled. Fixed here: zod schemas + a small custom `ZodValidationPipe`, applied per-route with `@UsePipes(new ZodValidationPipe(loginSchema))` on the controller method. This is arguably a better fit for this project anyway — writing your own validation pipe instead of trusting a framework-provided one is more in line with the "understand the mechanism, don't just trust the decorator" learning goal stated from the start.

**`prisma/prisma.service.ts`** — **Prisma 7 requires a driver adapter** (see note below)

```typescript
/**
 * @file prisma.service.ts
 * @description Nest-managed PrismaClient lifecycle. Prisma 7 removed the bundled
 * Rust engine — PrismaClient now must be constructed with a driver adapter
 * (or an Accelerate URL). This project uses @prisma/adapter-pg over the raw `pg` driver.
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

**`prisma/prisma.module.ts`**

```typescript
/**
 * @file prisma.module.ts
 * @description Global module — PrismaService is injectable everywhere without
 * every feature module needing to import PrismaModule explicitly.
 */
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

> **Note on Prisma 7:** this is a genuinely new requirement, not a stylistic choice — v7 dropped the Rust query engine entirely, and `PrismaClient` now throws if constructed without an adapter or an Accelerate URL. Two things worth double-checking against your actual setup, since they depend on your exact `schema.prisma` config: (1) the generator provider should be `prisma-client` (not the old `prisma-client-js`) in v7; (2) v7 can generate client output to a custom path instead of `node_modules/@prisma/client` — if your `import { User } from '@prisma/client'` in `auth.repository.ts` doesn't resolve, check your schema's generator `output` path and adjust the import accordingly.

```typescript
/**
 * @file auth.repository.ts
 * @description The only file in the auth feature allowed to touch PrismaService directly.
 */
import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  storeRefreshToken(userId: string, token: string): Promise<void> {
    return this.prisma.refreshToken.create({ data: { userId, token } }).then(() => undefined);
  }
}
```

**`auth.service.ts`**

```typescript
/**
 * @file auth.service.ts
 * @description Business logic: credential verification, token issuance and rotation.
 */
import { Injectable } from '@nestjs/common';
import { AuthRepository } from './auth.repository';
import { LoginDto } from './dto/login.dto';
import { InvalidCredentialsException } from '../common/exceptions/invalid-credentials.exception';
import { verifyPassword } from '../common/utils/hash';
import { signAccessToken, signRefreshToken } from '../common/utils/tokens';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(private readonly authRepository: AuthRepository) {}

  /**
   * Verifies credentials and issues a new access/refresh token pair.
   * @throws {InvalidCredentialsException} If email/password don't match.
   */
  async login(dto: LoginDto): Promise<TokenPair> {
    const user = await this.authRepository.findByEmail(dto.email);
    if (!user || !(await verifyPassword(dto.password, user.passwordHash))) {
      throw new InvalidCredentialsException();
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
 * @description HTTP layer for auth endpoints. No business logic, no Prisma access.
 */
import { Body, Controller, Post, Req, Res, UsePipes } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AuthService } from './auth.service';
import { LoginDto, loginSchema } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @UsePipes(new ZodValidationPipe(loginSchema))
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, refreshToken } = await this.authService.login(dto);

    if (req.headers['x-client'] === 'web') {
      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: true,
        sameSite: 'strict',
      });
    }

    return { accessToken, refreshToken };
  }
}
```

**`common/guards/jwt-auth.guard.ts`** — applied globally; routes opt out with `@Public()`

```typescript
/**
 * @file jwt-auth.guard.ts
 * @description Verifies the Bearer access token and attaches the user to the request.
 * Registered as a global guard (main.ts) — every route is protected by default.
 * Use @Public() to opt a route out.
 */
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { verifyAccessToken } from '../utils/tokens';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException();
    }

    request.user = verifyAccessToken(header.slice(7)); // throws if invalid/expired
    return true;
  }
}
```

**`common/decorators/public.decorator.ts`**

```typescript
/**
 * @file public.decorator.ts
 * @description Marks a route as exempt from the global JwtAuthGuard.
 */
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

**`common/interceptors/response.interceptor.ts`**

```typescript
/**
 * @file response.interceptor.ts
 * @description Wraps every successful response in { success, data }. Registered
 * globally in main.ts.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, { success: true; data: T }> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<{ success: true; data: T }> {
    return next.handle().pipe(map((data) => ({ success: true, data })));
  }
}
```

**`common/filters/http-exception.filter.ts`**

```typescript
/**
 * @file http-exception.filter.ts
 * @description Catches all HttpExceptions (including our custom ones) and shapes
 * the { success: false, error } envelope. Registered globally in main.ts.
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';

@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception.getStatus();
    const body = exception.getResponse();

    response.status(status).json({
      success: false,
      error: typeof body === 'string' ? { message: body } : body,
    });
  }
}
```

**`common/exceptions/invalid-credentials.exception.ts`**

```typescript
/**
 * @file invalid-credentials.exception.ts
 */
import { HttpException, HttpStatus } from '@nestjs/common';

export class InvalidCredentialsException extends HttpException {
  constructor() {
    super(
      { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
      HttpStatus.UNAUTHORIZED,
    );
  }
}
```

**`main.ts`**

```typescript
/**
 * @file main.ts
 * @description Application bootstrap — security middleware, global pipes/filters/
 * interceptors, CORS.
 */
```

> **CSRF note:** `csrf-csrf` is in your dependencies but not wired up above — it needs to be, specifically because the web client's refresh token rides in an `HttpOnly` cookie (§2). Any endpoint that trusts a cookie automatically is a CSRF target: a malicious site can make a browser send that cookie without the user's intent. `csrf-csrf` implements the double-submit cookie pattern to close that gap. This only matters for cookie-authenticated (web) requests — mobile's Bearer-token-only flow isn't exposed to CSRF the same way, since there's no ambient cookie a malicious page could ride on. Wire this into Phase 2 alongside the rest of the auth work, not deferred to later — it's a real gap in the auth flow as currently drafted, not a nice-to-have.

---

## 7. Strict Engineering Rules

1. **No `any`.** Use `unknown` + narrowing, a precise type, or a generic. Unavoidable cases need an inline comment justifying it.
2. **Modular, single-responsibility files/classes.** One controller, one service, one concern per file.
3. **Clean code.** Small methods, descriptive names, no dead/commented-out code.
4. **TSDoc on every file and every exported class/method/type** — `@file`/`@description` header, plus `@param`/`@returns`/`@throws` on exported members.
5. **Strict TypeScript**: `strict: true`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`. Nest's default `experimentalDecorators`/`emitDecoratorMetadata` stay on (required for DI).
6. **No direct Prisma access outside a feature's `.repository.ts`.**
7. **No cross-feature imports** except another feature's `.service.ts`.
8. **No business logic in controllers.** Controllers translate HTTP ↔ service calls only.
9. **All input validated via zod schemas + `ZodValidationPipe`** (§6) — never manually parse `req.body`. (Not class-validator — see the note in §6.)
10. **Throw typed exceptions** extending `HttpException` (`common/exceptions/`), never raw strings or generic `Error`.
11. **No magic strings/numbers** — named constants or enums.
12. **No `console.log`** — use Nest's built-in `Logger` class.
13. **Env validated at startup** via `ConfigModule.forRoot({ validationSchema: ... })` using **Joi** (fail-fast) — never read `process.env.X` ad hoc. Joi validates environment/config specifically; zod validates request DTOs (§6). Two different libraries for two different boundaries, not redundant — don't consolidate onto one for its own sake.
14. **Response envelope only via the global interceptor** — never shaped manually per controller.
15. **Document thrown exceptions** with `@throws` in TSDoc.
16. **No hardcoded secrets** — always via `ConfigService`.
17. **Routes are protected by default.** Use `@Public()` explicitly to opt out — never the reverse.

---

## 8. Security Middleware

Three packages beyond the core stack, all registered in `main.ts` (§6):

| Package         | Purpose                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `helmet`        | Sets secure HTTP headers (CSP, HSTS, etc.) — standard, low-effort hardening                                                                                                  |
| `cookie-parser` | Required to read `req.cookies` — needed the moment the web client's refresh-token cookie has to be read back (e.g. the `/auth/refresh` endpoint checking a web request)      |
| `csrf-csrf`     | Double-submit CSRF protection — needed specifically because the web refresh flow relies on an ambient `HttpOnly` cookie (§6 note). Not needed for mobile's Bearer-only flow. |

---

## 9. Testing

Jest (Nest's default — `@nestjs/testing`'s `Test.createTestingModule` and e2e helpers are built around it).

- Service tests: `Test.createTestingModule({ providers: [AuthService, { provide: AuthRepository, useValue: mockRepo }] })`.
- Repository tests: run against a real Dockerized test database.
- E2E: Nest's `supertest`-based e2e suite (`test/` folder, `*.e2e-spec.ts`).

---

## 10. Roadmap

| Phase | Focus                                                            |
| ----- | ---------------------------------------------------------------- |
| 1     | Foundation — Nest scaffold, Prisma, Docker Postgres              |
| 2     | Auth — Argon2, JWT guards, rotation, mobile + web token delivery |
| 3     | Workspaces, Projects, Documents                                  |
| 4     | RAG                                                              |
| 5     | AI Agents                                                        |
| 6     | Queues/workers                                                   |
| 7     | Notifications                                                    |
| 8     | Stripe (test mode)                                               |
| 9     | Docker multi-service, Nginx, Redis, observability                |

---

## 11. Open Decisions

- [ ] `X-Client` header exact contract (name/values) for mobile vs. web cookie logic
- [ ] Logging library beyond Nest's built-in `Logger` (candidates: pino via `nestjs-pino`)
- [ ] `csrf-csrf` wiring — needs to land alongside Phase 2 auth work, not deferred (§8)
- [ ] Confirm hosting target — `@nestjs/mau` is in devDependencies; if that's the intended deploy path, it changes the Docker/GHCR redeploy discussion from earlier (Mau likely handles its own build+deploy pipeline rather than needing a manually-pulled image)
