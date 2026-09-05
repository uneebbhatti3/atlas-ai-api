import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import helmet from 'helmet';
import { doubleCsrf } from 'csrf-csrf';
import cookieParser from 'cookie-parser';
import { Request } from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const cookieSecret = configService.getOrThrow<string>('COOKIE_SECRET');
  const csrfSecret = configService.getOrThrow<string>('CSRF_SECRET');
  const isProduction = process.env.NODE_ENV === 'production';

  app.use(cookieParser(cookieSecret));

  const { doubleCsrfProtection } = doubleCsrf({
    cookieName: '__Host-psifi.x-csrf-token',
    cookieOptions: {
      sameSite: 'lax' as const,
      secure: isProduction,
    },
    size: 64,
    ignoredMethods: ['GET', 'HEAD', 'OPTIONS'] as const,
    getCsrfTokenFromRequest: (req: Request) => {
      return req.headers['x-csrf-token'] as string;
    },
    getSecret: () => csrfSecret,
    getSessionIdentifier: (req: Request) => {
      return req.headers['x-session-identifier'] as string;
    },
  });

  app.use(doubleCsrfProtection);

  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        directives: {
          imgSrc: [
            `'self'`,
            'data:',
            'apollo-server-landing-page.cdn.apollographql.com',
          ],
          scriptSrc: [`'self'`],
          manifestSrc: [
            `'self'`,
            'apollo-server-landing-page.cdn.apollographql.com',
          ],
          frameSrc: [`'self'`, 'sandbox.embed.apollographql.com'],
        },
      },
    }),
  );

  app.enableCors({
    origin: configService.getOrThrow<string>('FRONTEND_URL'),
    credentials: true,
  });

  await app.listen(configService.getOrThrow<number>('PORT') ?? 8080);
}
bootstrap().catch(console.error);
