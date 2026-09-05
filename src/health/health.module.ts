/**
 * @file health.module.ts
 * @description Wires HealthController into the app. No service/repository —
 * this feature has no business logic or persistence.
 */
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
