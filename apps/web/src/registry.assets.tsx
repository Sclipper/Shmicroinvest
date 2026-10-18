import type { ScreenDef } from './shell/workspace.tsx';
import { AccountingRequests } from './assets/AccountingRequests.tsx';
import { AssetEditor } from './assets/AssetEditor.tsx';
import { FixedAssets } from './assets/FixedAssets.tsx';
import { AssetProtocol } from './assets/Protocols.tsx';
import { AssetsByCategoriesReport, DepreciationPlanReport, DepreciationQuotasReport, InventoryBookReport, InventoryListMolReport } from './assets/reports.tsx';

/** Fixed assets and depreciation (spec 03b): register, asset editor, accounting requests, protocols and reports. */
export const ASSET_SCREENS: ScreenDef[] = [
  { id: 'assets', title: 'Дълготрайни активи', component: FixedAssets, permission: 'UI_Operations_Depreciations' },
  { id: 'asset', title: 'Дълготраен актив', component: AssetEditor, permission: 'UI_Operations_Depreciations', multi: true },
  { id: 'assetProtocol', title: 'Протокол', component: AssetProtocol, permission: 'UI_Operations_Depreciations', multi: true },
  { id: 'accountingRequests', title: 'Заявки за осчетоводяване', component: AccountingRequests, permission: 'UI_Operations_AccountingRequests' },
  { id: 'assetQuotas', title: 'Месечни амортизационни квоти', component: DepreciationQuotasReport, permission: 'UI_Reporting_Depreciations_MonthlyDepreciationQuotas' },
  { id: 'assetInventoryBook', title: 'Инвентарна книга', component: InventoryBookReport, permission: 'UI_Reporting_Depreciations_InventoryBook' },
  { id: 'assetPlan', title: 'Амортизационен план', component: DepreciationPlanReport, permission: 'UI_Reporting_Depreciations_DepreciationPlan' },
  { id: 'assetCategories', title: 'Активи по категории', component: AssetsByCategoriesReport, permission: 'UI_Reporting_Depreciations_AssetsByCategories' },
  { id: 'assetInventoryMol', title: 'Инвентаризационен опис на ДМА', component: InventoryListMolReport, permission: 'UI_Reporting_Depreciations_InventoryListMOL' },
];
