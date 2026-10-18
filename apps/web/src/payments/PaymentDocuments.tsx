import { Empty } from '../components/ui.tsx';
import type { ScreenProps } from '../shell/workspace.tsx';

/** Placeholder (payments module): registry of one payment-document type. */
export function PaymentDocuments(_p: ScreenProps & { type: number }) {
  return <Empty>Предстои</Empty>;
}
