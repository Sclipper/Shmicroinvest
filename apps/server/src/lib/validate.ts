import { zValidator as zv } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import { config, locales, type ZodType } from 'zod';
import { ApiError } from './errors.ts';

// Built-in zod messages in Bulgarian (user-facing texts are Bulgarian).
config(locales.bg());

/** zod validator that fails with an ApiError carrying the first issue's message. */
export const zValidator = <T extends ZodType, Target extends keyof ValidationTargets>(target: Target, schema: T) =>
  zv(target, schema, (result) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
      throw new ApiError(400, `Невалидни данни${where}: ${issue?.message ?? ''}`.trim());
    }
  });
