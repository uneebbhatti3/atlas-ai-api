/**
 * @file health.controller.ts
 * @description Liveness endpoint. Render's health check (see render.yaml,
 * healthCheckPath: /health) polls this to decide if the service is up.
 */

import { Controller, Get } from '@nestjs/common';

@Controller('/health')
export class HealthController {
  /**
   * GET /health
   * @returns An object indicating service is up.
   */
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
