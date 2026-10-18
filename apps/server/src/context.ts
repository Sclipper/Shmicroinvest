import type { CompanyDb, DbDriver } from './db/provider.ts';

export interface SessionInfo {
  id: string;
  companyDb: string | null;
  userId: number | null;
  state: { appDateOffsetDays?: number; branchId?: number };
}

export interface ActiveUser {
  id: number;
  name: string;
  roleId: number;
  isAdmin: boolean;
}

export interface ActiveYear {
  id: number;
  year: number;
  startDate: string;
  isLocked: boolean;
  lockedMonths: number;
  isConcluded: boolean;
}

export type AppEnv = {
  Variables: {
    driver: DbDriver;
    session: SessionInfo;
    db: CompanyDb;
    user: ActiveUser;
    year: ActiveYear;
    can: (key: string) => Promise<boolean>;
  };
};
