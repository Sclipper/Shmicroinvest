import { Hono } from 'hono';
import type { AppEnv } from '../context.ts';

/** Placeholder; implemented by the payments module. */
export const paymentDocumentsRoutes = new Hono<AppEnv>();
