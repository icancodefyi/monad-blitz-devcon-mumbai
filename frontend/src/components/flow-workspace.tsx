"use client";

import { CircleDollarSign, ExternalLink, ShieldCheck, Wallet } from "lucide-react";
import { FormEvent, useState } from "react";

import { MascotLoader } from "@/components/mascot";
import { ReportDownloadButton } from "@/components/report-download-button";
import {
  applyFlowAction,
  confirmFlowTransaction,
  createFlowTask,
  type FlowCompletedTask,
  recordFlowSubmission,
  waitForTask,
} from "@/lib/donads-api";
import { testnetTransactionUrl } from "@/lib/chain-config";
import { forgetPendingFlowHash, readPendingFlowHash, rememberPendingFlowHash } from "@/lib/flow-submission";
import { connectWalletProvider, connectedAccounts, ensureMonadTestnet, getConnectedWalletProvider, monToWeiHex } from "@/lib/wallet-provider";

const inputClass = "min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring";

export function FlowWorkspace() {
  const [purpose, setPurpose] = useState("");
  const [address, setAddress] = useState("");
  const [amount, setAmount] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [task, setTask] = useState<FlowCompletedTask | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connectWallet() {
    setError(null);
    setWorking(true);
    try {
      await connectWalletProvider();
      await ensureMonadTestnet();
      const accounts = await connectedAccounts();
      if (!accounts[0]) throw new Error("Wallet returned no account.");
      setWalletAddress(accounts[0]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Wallet connection was rejected.");
    } finally {
      setWorking(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!walletAddress) {
      setError("Connect a Monad Testnet wallet first.");
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const created = await createFlowTask({
        title: "Monad transfer",
        purpose,
        payer: walletAddress,
        payouts: [{ recipient_name: "Recipient", recipient_address: address, asset: "MON", amount, milestone: purpose, deadline: null }],
        approval_conditions: ["Exact sender, recipient and MON amount approved"],
        linked_task_id: null,
      });
      const completed = await waitForTask(created.id);
      if (completed.status.state !== "completed" || completed.bot !== "flow") throw new Error("Flow did not return an intent.");
      setTask(completed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Flow failed.");
    } finally {
      setWorking(false);
    }
  }

  async function reject() {
    if (!task || task.status.data.workflow.state !== "awaiting_approval") return;
    setWorking(true);
    setError(null);
    try {
      setTask((await applyFlowAction(task.id, { action: "reject", reason: "Rejected by user" })).task);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Rejection failed.");
    } finally {
      setWorking(false);
    }
  }

  async function authorizeAndSend() {
    if (!task) return;
    setWorking(true);
    setError(null);
    try {
      let current = task;
      if (current.status.data.workflow.state === "awaiting_approval") {
        current = (await applyFlowAction(task.id, { action: "approve" })).task;
        setTask(current);
      }

      let transactionHash = current.status.data.workflow.submission?.transaction_hash ?? readPendingFlowHash(task.id);
      if (current.status.data.workflow.state === "authorized") {
        if (!transactionHash) {
          const provider = getConnectedWalletProvider() ?? await connectWalletProvider();
          const workflow = current.status.data.workflow;
          await ensureMonadTestnet();
          const accounts = await connectedAccounts();
          const from = accounts[0];
          if (!from || from.toLowerCase() !== workflow.payer.toLowerCase()) {
            throw new Error("Connected wallet does not match the wallet bound to this intent.");
          }
          const payout = workflow.payouts[0];
          transactionHash = await provider.request({
            method: "eth_sendTransaction",
            params: [{ from, to: payout.recipient_address, value: monToWeiHex(payout.amount) }],
          }) as string;
          rememberPendingFlowHash(task.id, transactionHash);
        }
        current = await recordFlowSubmission(task.id, transactionHash);
        setTask(current);
      }

      if (!transactionHash) throw new Error("No wallet transaction has been submitted for this intent.");
      let lastError: Error | undefined;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          setTask(await confirmFlowTransaction(task.id, transactionHash));
          forgetPendingFlowHash(task.id);
          return;
        } catch (reason) {
          lastError = reason instanceof Error ? reason : new Error("Receipt verification failed.");
          if (!/not been mined|not known/i.test(lastError.message)) throw lastError;
          await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        }
      }
      throw lastError ?? new Error("The submitted transaction was not confirmed before the timeout. Retry verification; DONADS will not send it again.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Transaction failed.");
    } finally {
      setWorking(false);
    }
  }

  const workflow = task?.status.data.workflow;
  const actionable = workflow && ["awaiting_approval", "authorized", "submitted"].includes(workflow.state);
  return (
    <main className="flex-1 overflow-y-auto p-4 sm:p-8">
      <div className="mx-auto max-w-2xl space-y-6">
        {working ? <MascotLoader label={workflow?.state === "submitted" ? "Verifying the submitted Monad transaction…" : "Preparing the exact Monad intent…"} /> : null}
        <header>
          <div className="flex items-center gap-3"><CircleDollarSign className="size-7" /><h1 className="text-3xl font-semibold tracking-tight">Monad transfer</h1></div>
          <p className="mt-2 text-sm text-muted-foreground">Connect your wallet, approve the exact native MON transfer, and let DONADS verify the mined receipt through Monad RPC.</p>
        </header>
        <section className="rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><p className="text-sm font-medium">Monad Testnet wallet</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{walletAddress || "Not connected"}</p></div>
            <button type="button" disabled={working} onClick={() => void connectWallet()} className="flex min-h-11 items-center gap-2 rounded-xl border border-border px-4 text-sm font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-40"><Wallet className="size-4" aria-hidden="true" />{walletAddress ? "Reconnect" : "Connect wallet"}</button>
          </div>
        </section>
        {!workflow ? (
          <form onSubmit={submit} className="space-y-4 rounded-2xl border border-border bg-card p-5">
            <label className="block text-sm font-medium">Purpose<textarea required rows={3} value={purpose} onChange={(event) => setPurpose(event.target.value)} className={`${inputClass} mt-1 py-2`} /></label>
            <label className="block text-sm font-medium">Recipient address<input required value={address} onChange={(event) => setAddress(event.target.value)} placeholder="0x…" autoComplete="off" autoCapitalize="none" spellCheck={false} className={`${inputClass} mt-1 font-mono`} /></label>
            <label className="block text-sm font-medium">Amount in MON<input required value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" autoComplete="off" className={`${inputClass} mt-1 font-mono`} /></label>
            <button disabled={working || !walletAddress} className="min-h-11 rounded-xl bg-primary px-5 text-sm font-medium text-primary-foreground disabled:opacity-40">{working ? "Validating…" : "Prepare exact transfer"}</button>
          </form>
        ) : (
          <section className="space-y-4 rounded-2xl border border-border bg-card p-5">
            <h2 className="text-xl font-semibold">{workflow.purpose}</h2>
            {workflow.payouts.map((payout, index) => <div key={index} className="rounded-xl border border-border p-4"><p className="font-medium">{payout.amount} MON</p><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{payout.recipient_address}</p></div>)}
            <div className="rounded-xl bg-muted p-4 text-sm"><ShieldCheck className="mb-2 size-5" />State: <span className="font-mono">{workflow.state}</span>. Completion requires a successful RPC receipt matching this exact intent.</div>
            {actionable ? <div className="flex flex-wrap gap-3"><button disabled={working} onClick={() => void authorizeAndSend()} className="min-h-11 rounded-xl bg-primary px-4 text-sm text-primary-foreground">{working ? "Waiting for confirmation…" : workflow.state === "submitted" ? "Verify submitted transaction" : "Approve in wallet and send"}</button>{workflow.state === "awaiting_approval" ? <button disabled={working} onClick={() => void reject()} className="min-h-11 rounded-xl border border-border px-4 text-sm">Reject</button> : null}</div> : null}
            {workflow.execution ? <a className="inline-flex items-center gap-2 text-sm underline" href={testnetTransactionUrl(workflow.execution.transaction_hash)} target="_blank" rel="noreferrer">Verified on MonadScan <ExternalLink className="size-4" /></a> : null}
          </section>
        )}
        {task ? <ReportDownloadButton task={task} /> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </div>
    </main>
  );
}
