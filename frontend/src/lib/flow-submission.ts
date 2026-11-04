const PREFIX = "donads_flow_submission:";
const HASH = /^0x[0-9a-f]{64}$/i;

function key(taskId: string, payoutIndex: number): string { return `${PREFIX}${taskId}:${payoutIndex}`; }

export function readPendingFlowHash(taskId: string, payoutIndex = 0): string | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(key(taskId, payoutIndex)) ?? (payoutIndex === 0 ? window.localStorage.getItem(`${PREFIX}${taskId}`) : null);
  return value && HASH.test(value) ? value.toLowerCase() : null;
}

export function rememberPendingFlowHash(taskId: string, transactionHash: string, payoutIndex = 0): void {
  if (!HASH.test(transactionHash)) throw new Error("Wallet returned an invalid transaction hash.");
  window.localStorage.setItem(key(taskId, payoutIndex), transactionHash.toLowerCase());
}

export function forgetPendingFlowHash(taskId: string, payoutIndex = 0): void {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(key(taskId, payoutIndex));
    if (payoutIndex === 0) window.localStorage.removeItem(`${PREFIX}${taskId}`);
  }
}
