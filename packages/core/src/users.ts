import type { ValidationMessage } from './journal.ts';

/** Users screen messages (UsersListViewModel, spec 01b 3.4). */
export const USER_SCREEN_MESSAGES = {
  strUserNameIsEmpty: 'Попълнете потребителски име', // sic (spec 01b 3.4)
  strUserNameExists: 'Вече съществува потребител с такова име.',
  strUserPasswordsDontMatch: 'Паролите не съвпадат',
  strUserPasswordMissing: 'Потребителят няма въведена парола.',
  strPasswordNotSecure: 'Въведената парола не отговаря на изискванията за "силна" парола. Желаете ли продължение?',
  strSelectBaseUserRoleToAddUserOrRole: 'Не може да създавате подгрупи в тази група',
  strUserCountValidation: 'Въведен е само един потребител...',
  strDeleteUserConfirmation: 'Желаете ли изтриване на избрания потребител?',
  strUserHasOperations: 'Потребителят не може да бъде изтрит, тъй като участва в операции!',
} as const;

/** Minimum length of a "strong" password (01b 3.4: weak if length < 6). */
export const STRONG_PASSWORD_LENGTH = 6;

/**
 * Password checks of the users screen (01b 3.4). Neither blocks: no password
 * warns (strUserPasswordMissing), a short one asks strPasswordNotSecure.
 */
export function userPasswordChecks(password: string): ValidationMessage[] {
  if (password === '') return [{ key: 'strUserPasswordMissing', text: USER_SCREEN_MESSAGES.strUserPasswordMissing, severity: 'warning' }];
  if (password.length < STRONG_PASSWORD_LENGTH) return [{ key: 'strPasswordNotSecure', text: USER_SCREEN_MESSAGES.strPasswordNotSecure, severity: 'warning' }];
  return [];
}
