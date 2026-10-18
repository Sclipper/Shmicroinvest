import type { ValidationMessage } from '@shmi/core';

/** Error with a user-facing Bulgarian message; serialised as { error, messages? }. */
export class ApiError extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;
  messages?: ValidationMessage[];
  code?: string;
  constructor(status: ApiError['status'], message: string, messages?: ValidationMessage[], code?: string) {
    super(message);
    this.status = status;
    this.messages = messages;
    this.code = code;
  }
}

export const notFound = (what = 'Записът') => new ApiError(404, `${what} не е намерен.`);
export const forbidden = () => new ApiError(403, 'Нямате права за тази операция.');
export const badRequest = (msg: string, code?: string) => new ApiError(400, msg, undefined, code);
