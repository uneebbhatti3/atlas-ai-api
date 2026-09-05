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
    prisma.service.ts    # extends PrismaClient, manages connection lifecycle
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

**`dto/login.dto.ts`**

```typescript
/**
 * @file login.dto.ts
 * @description Request contract for POST /auth/login. Validated automatically by
 * the global ValidationPipe (class-validator) before reaching the controller.
 */
import { IsEmail, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @MinLength(8)
  password: string;
}
```

**`auth.repository.ts`**

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
import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
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
 * @description Application bootstrap — global pipes, filters, interceptors, CORS.
 */
```

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
9. **All input validated via class-validator DTOs** — the global `ValidationPipe` enforces this; never manually parse `req.body`.
10. **Throw typed exceptions** extending `HttpException` (`common/exceptions/`), never raw strings or generic `Error`.
11. **No magic strings/numbers** — named constants or enums.
12. **No `console.log`** — use Nest's built-in `Logger` class.
13. **Env validated at startup** via `ConfigModule` (fail-fast) — never read `process.env.X` ad hoc.
14. **Response envelope only via the global interceptor** — never shaped manually per controller.
15. **Document thrown exceptions** with `@throws` in TSDoc.
16. **No hardcoded secrets** — always via `ConfigService`.
17. **Routes are protected by default.** Use `@Public()` explicitly to opt out — never the reverse.

---

## 8. Testing

Jest (Nest's default — `@nestjs/testing`'s `Test.createTestingModule` and e2e helpers are built around it).

- Service tests: `Test.createTestingModule({ providers: [AuthService, { provide: AuthRepository, useValue: mockRepo }] })`.
- Repository tests: run against a real Dockerized test database.
- E2E: Nest's `supertest`-based e2e suite (`test/` folder, `*.e2e-spec.ts`).

---

## 9. Roadmap

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

## 10. Open Decisions

- [ ] `X-Client` header exact contract (name/values) for mobile vs. web cookie logic
- [ ] Logging library beyond Nest's built-in `Logger` (candidates: pino via `nestjs-pino`)
