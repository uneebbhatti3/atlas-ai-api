import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma/prisma.service';
import { z } from 'zod';
import { APP_GUARD } from '@nestjs/core';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,
        limit: 3,
      },
      {
        name: 'medium',
        ttl: 10000,
        limit: 20,
      },
      {
        name: 'long',
        ttl: 60000,
        limit: 100,
      },
    ]),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validationSchema: z.object({
        DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
        PORT: z.coerce.number().default(8000),
        CSRF_SECRET: z.string().min(1, 'CSRF_SECRET is required'),
        COOKIE_SECRET: z.string().min(1, 'COOKIE_SECRET is required'),
        FRONTEND_URL: z.string().url('FRONTEND_URL must be a valid URI'),
        NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
      }),
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    PrismaService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
