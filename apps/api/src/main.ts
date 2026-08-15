/**
 * apps/api/src/main.ts
 *
 * CLAUDE.md §9 — the Paystack webhook route MUST receive the raw request
 * body, not JSON already parsed and re-serialised, or signature
 * verification silently breaks for every genuinely legitimate webhook
 * (see paystack.controller.ts header comment). This is configured here,
 * once, rather than trusted to be remembered per-route.
 */

import 'reflect-metadata';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // The webhook route gets the RAW body as a Buffer. Every other route
  // gets normal parsed JSON. Order matters: the raw parser is scoped to
  // exactly one path so nothing else on the API is affected.
  app.use('/webhooks/paystack', express.raw({ type: 'application/json' }));
  app.use(express.json());

  const port = process.env['PORT'] ?? 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console -- startup log, not runtime logging
  console.log(`Provia API listening on port ${String(port)}`);
}

bootstrap().catch((err: unknown) => {
  console.error('Fatal error during bootstrap:', err);
  process.exit(1);
});
