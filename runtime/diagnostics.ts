import type { EmitReceipt } from './types.ts';

export type ReceiptListener = (receipt: EmitReceipt) => void;

export interface Diagnostics {
  emit(receipt: EmitReceipt): void;
  drain(): EmitReceipt[];
}

export function createDiagnostics(listener?: ReceiptListener, enabled = true): Diagnostics {
  const buffer: EmitReceipt[] = [];
  return {
    emit(receipt) {
      if (!enabled) return;
      buffer.push(receipt);
      listener?.(receipt);
    },
    drain() {
      return buffer.splice(0, buffer.length);
    },
  };
}
