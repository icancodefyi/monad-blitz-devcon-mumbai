"use client";

import { Bell, ChevronRight, CircleDollarSign, Clock3, Coins, Gauge, LogOut, Menu, Megaphone, MessageSquarePlus, Radar, RefreshCw, ShieldCheck, ShoppingBag, Trash2, WalletCards, Workflow, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { MascotLoader, MascotMark, SpecialistMark } from "@/components/mascot";
import { UnifiedTaskWorkspace } from "@/components/unified-task-workspace";
import { WalletConnectControl } from "@/components/wallet-kit";
import { createAuthChallenge, createTelegramConnection, deleteTaskHistory, getAiUsage, getTask, getTelegramConnection, getWalletBalance, getWalletTokenBalances, listPendingApprovals, listTaskHistory, removeTelegramConnection, restoreWalletSession, revokeWalletSession, setAccessToken, type AiUsage, type Task, type TelegramConnection, type TokenBalance, type WalletBalance, verifyWalletSignature } from "@/lib/donads-api";
import type { PendingApproval } from "@/lib/approvals";
import { canDeleteTaskHistory, taskDisplayTitle } from "@/lib/task-history";
import { connectWalletProvider, connectedAccounts, disconnectWalletProvider, openWalletChooser, walletConnectionMessage, withWalletTimeout } from "@/lib/wallet-provider";

const specialists = [
  { id: "scout", name: "Scout", specialty: "Cited research", summary: "Turns supplied public sources into concise findings with traceable citations.", goodAt: ["Source comparison", "Evidence extraction", "Research briefs"], prompts: ["Compare these three protocol docs", "Summarize this proposal with citations", "Find conflicts across these sources"], icon: Radar },
  { id: "commerce", name: "Commerce", specialty: "Crypto checkout", summary: "Validates crypto-accepting offers and prepares an approval-bounded purchase workflow.", goodAt: ["Offer verification", "Exact-budget checks", "Order receipt tracking"], prompts: ["Verify this product and crypto checkout", "Compare these merchant offers", "Prepare a purchase under my MON budget"], icon: ShoppingBag },
  { id: "growth", name: "Growth", specialty: "Campaign drafts", summary: "Builds structured, review-ready campaign drafts from a goal, audience, and evidence.", goodAt: ["Campaign calendars", "Channel-specific drafts", "Brand-safe messaging"], prompts: ["Create a 7-day launch campaign", "Draft an X and LinkedIn announcement", "Turn this research into campaign copy"], icon: Megaphone },
  { id: "flow", name: "Flow", specialty: "Monad payments", summary: "Prepares an exact Monad Testnet transfer and verifies the mined receipt after wallet approval.", goodAt: ["Exact transfer intents", "Wallet confirmation", "Receipt verification"], prompts: ["Send 0.01 MON to this address", "Prepare a contributor payment", "Verify this Monad transaction"], icon: CircleDollarSign },
  { id: "operator", name: "Operator", specialty: "Cross-agent coordination", summary: "Breaks a goal into bounded specialist steps, resolves dependencies, and tracks completion.", goodAt: ["Task decomposition", "Parallel execution", "Cross-agent handoffs"], prompts: ["Research this project and create a campaign", "Coordinate research before payment preparation", "Run this saved multi-step routine"], icon: Workflow },
  { id: "sentinel", name: "Sentinel", specialty: "Security triage", summary: "Performs deterministic EVM bytecode triage and enforces transaction policy boundaries.", goodAt: ["Opcode risk signals", "Transfer policy checks", "Fail-closed validation"], prompts: ["Scan this EVM bytecode", "Check this transfer against policy", "Explain the bytecode risk signals"], icon: ShieldCheck },
] as const;

type Specialist = (typeof specialists)[number];

function SpecialistDialog({ specialist, onClose }: { specialist: Specialist; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);
  const Icon = specialist.icon;
  return <dialog ref={ref} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-foreground/30 backdrop:backdrop-blur-sm">
    <div className="p-6 sm:p-7"><div className="flex items-start gap-4"><SpecialistMark icon={Icon} size={48} /><div className="min-w-0 flex-1"><p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">{specialist.specialty}</p><h2 className="mt-1 text-2xl font-semibold tracking-tight">{specialist.name}</h2></div><button type="button" aria-label="Close specialist details" onClick={onClose} className="grid size-10 place-items-center rounded-lg hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"><X className="size-4" aria-hidden="true" /></button></div>
      <p className="mt-5 text-sm leading-6 text-muted-foreground">{specialist.summary}</p>
      <div className="mt-6 grid gap-6 sm:grid-cols-2"><section><h3 className="text-sm font-semibold">What it is good at</h3><ul className="mt-3 space-y-2">{specialist.goodAt.map((item) => <li key={item} className="flex gap-2 text-sm"><span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />{item}</li>)}</ul></section><section><h3 className="text-sm font-semibold">Questions to ask</h3><ul className="mt-3 space-y-2">{specialist.prompts.map((item) => <li key={item} className="rounded-lg bg-muted px-3 py-2 text-xs leading-5">{item}</li>)}</ul></section></div>
      <p className="mt-6 border-t border-border pt-4 text-xs leading-5 text-muted-foreground">You still submit every request through the main task box. Operator adds this specialist automatically when the goal requires it.</p>
    </div>
  </dialog>;
}

function resetLabel(resetsAtMs: number): string { const minutes = Math.max(0, Math.ceil((resetsAtMs - Date.now()) / 60_000)); return `${Math.floor(minutes / 60)}h ${minutes % 60}m`; }

export function taskAddressSuggestions(tasks: Task[], wallet: string | null): Array<{ label: string; address: string }> {
  const suggestions: Array<{ label: string; address: string }> = [];
  const seen = new Set<string>();
  const add = (label: string, address: string) => { const normalized = address.toLowerCase(); if (!seen.has(normalized)) { seen.add(normalized); suggestions.push({ label, address }); } };
  if (wallet) add("Connected wallet", wallet);
  for (const task of tasks) {
    const addresses = JSON.stringify({ prompt: task.prompt, input: task.input, status: task.status }).match(/0x[a-fA-F0-9]{40}\b/g) ?? [];
    const prompt = task.prompt.toLowerCase();
    const label = prompt.includes("escrow") ? "Active escrow" : prompt.includes("vault") ? "My vault" : prompt.includes("token") ? "Verified token" : "Last recipient";
    addresses.forEach((address) => add(label, address));
    if (suggestions.length >= 4) break;
  }
  return suggestions.slice(0, 4);
}

function ApprovalDialog({ approvals, onClose, onReview }: { approvals: PendingApproval[]; onClose: () => void; onReview: (approval: PendingApproval) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, []);
  return <dialog ref={ref} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-2xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-foreground/30 backdrop:backdrop-blur-sm">
    <div className="flex items-start gap-3 border-b border-border p-5"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted"><Bell className="size-5" aria-hidden="true" /></span><div className="min-w-0 flex-1"><h2 className="text-lg font-semibold tracking-tight">Action needed</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">These checkpoints are synced to this wallet across phone and desktop.</p></div><button type="button" aria-label="Close action inbox" onClick={onClose} className="grid size-10 place-items-center rounded-lg hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" aria-hidden="true" /></button></div>
    <div className="max-h-[58dvh] overflow-y-auto p-3">{approvals.length ? <ul className="space-y-2">{approvals.map((approval) => <li key={`${approval.task_id}-${approval.kind}`} className="rounded-xl border border-border p-4"><div className="flex items-start gap-3"><span className={`mt-1 size-2 shrink-0 rounded-full ${approval.reminder_due ? "bg-destructive" : "bg-primary"}`} aria-hidden="true" /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{approval.title}</h3>{approval.reminder_due ? <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-1 text-[10px] font-medium text-destructive"><Clock3 className="size-3" aria-hidden="true" />Waiting</span> : null}</div><p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{approval.summary}</p><p className="mt-2 text-[11px] capitalize text-muted-foreground">{approval.bot} · {approval.state.replaceAll("_", " ")}</p></div></div><button type="button" onClick={() => onReview(approval)} className="mt-3 min-h-10 w-full rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-px">Review checkpoint</button></li>)}</ul> : <div className="px-4 py-10 text-center"><p className="text-sm font-medium">Nothing needs you right now</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Long-running work continues without creating unnecessary approvals.</p></div>}</div>
    <div className="border-t border-border"><TelegramControl /></div>
  </dialog>;
}

function TelegramControl() {
  const [status, setStatus] = useState<TelegramConnection | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const controller = new AbortController(); void getTelegramConnection(controller.signal).then(setStatus).catch(() => undefined); return () => controller.abort(); }, []);
  if (!status?.configured) return null;
  async function connect() {
    setWorking(true); setError(null);
    const popup = window.open("about:blank", "_blank");
    try {
      const link = await createTelegramConnection();
      if (popup) { popup.opener = null; popup.location.replace(link.url); }
      else window.location.assign(link.url);
      const deadline = Math.min(link.expires_at_ms, Date.now() + 2 * 60_000);
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_500));
        const next = await getTelegramConnection();
        setStatus(next);
        if (next.connected) break;
      }
    } catch (reason) { popup?.close(); setError(reason instanceof Error ? reason.message : "Telegram could not be connected."); }
    finally { setWorking(false); }
  }
  async function disconnect() {
    setWorking(true); setError(null);
    try { await removeTelegramConnection(); setStatus({ ...status!, connected: false, username: null, linked_at_ms: null }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Telegram could not be disconnected."); }
    finally { setWorking(false); }
  }
  return <div className="p-4"><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-semibold">Telegram approvals</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Approve or reject exact transfers from Telegram. Your wallet still signs every transaction.</p></div><button type="button" disabled={working} aria-busy={working} onClick={() => void (status.connected ? disconnect() : connect())} className="min-h-10 shrink-0 rounded-lg border border-border px-3 text-xs font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50">{working ? "Checking…" : status.connected ? "Disconnect" : "Connect"}</button></div>{status.connected ? <p className="mt-2 text-xs text-muted-foreground">Connected{status.username ? ` as @${status.username}` : ""}</p> : null}{error ? <p role="alert" className="mt-2 text-xs leading-5 text-destructive">{error}</p> : null}</div>;
}

function BalanceDialog({ native, tokens, onClose }: { native: WalletBalance; tokens: TokenBalance[]; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; if (!dialog) return; if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", ""); }, []);
  return <dialog ref={ref} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }} className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-foreground/30 backdrop:backdrop-blur-sm">
    <div className="flex items-start gap-3 border-b border-border p-5"><span className="grid size-10 place-items-center rounded-xl bg-muted"><Coins className="size-5" aria-hidden="true" /></span><div className="min-w-0 flex-1"><h2 className="text-lg font-semibold">Testnet balances</h2><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{native.address}</p></div><button type="button" aria-label="Close balances" onClick={onClose} className="grid size-10 place-items-center rounded-lg hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"><X className="size-4" aria-hidden="true" /></button></div>
    <div className="space-y-2 p-4"><div className="flex items-baseline justify-between rounded-xl bg-muted p-4"><span className="text-sm font-medium">MON</span><span className="font-mono text-sm tabular-nums">{Number(native.balance_mon).toLocaleString(undefined, { maximumFractionDigits: 6 })}</span></div>{tokens.map((token) => <div key={token.contract} className="rounded-xl border border-border p-4"><div className="flex items-baseline justify-between gap-3"><span className="text-sm font-medium">{token.symbol}</span><span className="font-mono text-sm tabular-nums">{token.balance_formatted}</span></div><p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">{token.contract}</p></div>)}{!tokens.length ? <p className="px-2 py-6 text-center text-xs leading-5 text-muted-foreground">No ERC-20 contracts in this wallet’s DONADS history yet. Prepare a token transfer to add its verified balance.</p> : null}<p className="px-1 pt-2 text-[11px] text-muted-foreground">Monad Testnet · live RPC values</p></div>
  </dialog>;
}

export function WalletMenuDialog({ address, working, onChange, onDisconnect, onClose }: { address: string; working: boolean; onChange: () => void; onDisconnect: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; if (!dialog) return; if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", ""); }, []);
  return <dialog ref={ref} onCancel={(event) => { event.preventDefault(); if (!working) onClose(); }} onClick={(event) => { if (event.target === event.currentTarget && !working) onClose(); }} className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-foreground/30 backdrop:backdrop-blur-sm">
    <div className="flex items-start gap-3 border-b border-border p-5"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted"><WalletCards className="size-5" aria-hidden="true" /></span><div className="min-w-0 flex-1"><h2 className="text-lg font-semibold tracking-tight">Connected wallet</h2><p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={address}>{address}</p></div><button type="button" aria-label="Close wallet menu" disabled={working} onClick={onClose} className="grid size-10 place-items-center rounded-lg hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"><X className="size-4" aria-hidden="true" /></button></div>
    <div className="space-y-2 p-4"><button type="button" disabled={working} aria-busy={working} onClick={onChange} className="flex min-h-12 w-full items-center gap-3 rounded-xl bg-primary px-4 text-left text-sm font-medium text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-px disabled:opacity-50"><RefreshCw className="size-4" aria-hidden="true" /><span className="flex-1">{working ? "Opening wallet selection…" : "Change wallet"}</span></button><button type="button" disabled={working} onClick={onDisconnect} className="flex min-h-12 w-full items-center gap-3 rounded-xl border border-border px-4 text-left text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-px disabled:opacity-50"><LogOut className="size-4" aria-hidden="true" /><span>Disconnect from DONADS</span></button><p className="px-1 pt-2 text-xs leading-5 text-muted-foreground">Changing wallets ends this DONADS session. History and approvals remain attached to the original wallet.</p></div>
  </dialog>;
}

export function DeleteHistoryDialog({ task, working, error, onClose, onConfirm }: { task: Task; working: boolean; error: string | null; onClose: () => void; onConfirm: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const deletion = canDeleteTaskHistory(task);
  useEffect(() => { const dialog = ref.current; if (!dialog) return; if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", ""); }, []);
  return <dialog ref={ref} onCancel={(event) => { event.preventDefault(); if (!working) onClose(); }} onClick={(event) => { if (event.target === event.currentTarget && !working) onClose(); }} className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-card p-0 text-foreground shadow-xl backdrop:bg-foreground/30 backdrop:backdrop-blur-sm">
    <div className="flex items-start gap-3 border-b border-border p-5"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-destructive/10 text-destructive"><Trash2 className="size-5" aria-hidden="true" /></span><div className="min-w-0 flex-1"><h2 className="text-lg font-semibold tracking-tight">Delete from history?</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">{taskDisplayTitle(task)}</p></div><button type="button" aria-label="Close delete confirmation" disabled={working} onClick={onClose} className="grid size-10 place-items-center rounded-lg hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><X className="size-4" aria-hidden="true" /></button></div>
    <div className="space-y-4 p-5"><p className="text-sm leading-6">This removes the conversation from your history. Verified transaction receipts and security audit evidence remain preserved.</p>{deletion.reason ? <p role="alert" className="rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground">{deletion.reason}</p> : null}{error ? <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-xs leading-5 text-destructive">{error}</p> : null}<div className="flex justify-end gap-2"><button type="button" disabled={working} onClick={onClose} className="min-h-10 rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50">Cancel</button><button type="button" disabled={working || !deletion.allowed} aria-busy={working} onClick={onConfirm} className="min-h-10 rounded-lg bg-destructive px-4 text-sm font-medium text-destructive-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-px disabled:opacity-50">{working ? "Deleting…" : "Delete history"}</button></div></div>
  </dialog>;
}

function Sidebar({ open, onClose, onNewTask, onSpecialist, onHistory, onDeleteHistory, history, historyReady, aiUsage }: { open: boolean; onClose: () => void; onNewTask: () => void; onSpecialist: (specialist: Specialist) => void; onHistory: (task: Task) => void; onDeleteHistory: (task: Task) => void; history: Task[]; historyReady: boolean; aiUsage: AiUsage | null }) {
  const [specialistsOpen, setSpecialistsOpen] = useState(false);
  return <>
    {open ? <button type="button" aria-label="Close navigation" className="fixed inset-0 z-30 bg-foreground/20 backdrop-blur-[2px] lg:hidden" onClick={onClose} /> : null}
    <aside aria-label="DONADS navigation" className={`donads-sidebar fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-card px-2 py-3 transition-transform duration-200 motion-reduce:transition-none lg:static lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`}>
      <div className="flex h-12 items-center justify-between px-2"><div className="flex items-center gap-2.5"><MascotMark size={32} /><span className="text-sm font-semibold tracking-tight">DONADS</span></div><button type="button" aria-label="Close sidebar" onClick={onClose} className="grid size-10 place-items-center rounded-lg hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring lg:hidden"><X className="size-4" aria-hidden="true" /></button></div>
      <nav className="mt-3 space-y-1" aria-label="Workspace"><button type="button" onClick={onNewTask} className="flex min-h-10 w-full items-center gap-3 rounded-lg bg-muted px-3 text-sm font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 active:translate-y-px"><MessageSquarePlus className="size-4" aria-hidden="true" />New task</button><button type="button" aria-expanded={specialistsOpen} aria-controls="specialist-navigation" onClick={() => setSpecialistsOpen((value) => !value)} className="flex min-h-10 w-full items-center gap-3 rounded-lg px-3 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"><Workflow className="size-4" aria-hidden="true" /><span>Specialists</span><ChevronRight className={`ml-auto size-4 transition-transform duration-150 motion-reduce:transition-none ${specialistsOpen ? "rotate-90" : ""}`} aria-hidden="true" /></button></nav>
      {specialistsOpen ? <ul id="specialist-navigation" className="mt-1 space-y-0.5 border-l border-border pl-2">{specialists.map((specialist) => { const Icon = specialist.icon; return <li key={specialist.id}><button type="button" onClick={() => onSpecialist(specialist)} aria-label={`Learn about ${specialist.name}`} className="flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"><SpecialistMark icon={Icon} size={28} /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{specialist.name}</span><span className="block truncate text-xs text-muted-foreground">{specialist.specialty}</span></span></button></li>; })}</ul> : null}
      <section className="mt-6 flex min-h-0 flex-1 flex-col" aria-label="Task history"><p className="px-3 pb-2 text-xs font-medium text-muted-foreground">Recent</p>{!historyReady ? <div className="space-y-2 px-3" aria-label="Loading task history">{[1,2,3].map((item) => <div key={item} className="h-10 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />)}</div> : history.length ? <ol className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">{history.map((task) => <li key={task.id} className="group flex items-center rounded-lg hover:bg-muted"><button type="button" onClick={() => onHistory(task)} className="min-w-0 flex-1 rounded-lg px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring"><p className="truncate text-xs font-medium">{taskDisplayTitle(task)}</p><p className="mt-0.5 truncate text-xs capitalize text-muted-foreground">{task.bot} · {task.status.state}</p></button><button type="button" onClick={() => onDeleteHistory(task)} aria-label={`Delete ${taskDisplayTitle(task)} from history`} className="grid size-10 shrink-0 place-items-center rounded-lg text-muted-foreground opacity-100 hover:bg-destructive/10 hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring lg:opacity-0 lg:group-hover:opacity-100 lg:focus-visible:opacity-100"><Trash2 className="size-4" aria-hidden="true" /></button></li>)}</ol> : <p className="px-3 py-2 text-xs leading-5 text-muted-foreground">Your completed work will appear here.</p>}</section>
      {aiUsage ? <section className="mt-3 border-t border-border px-3 pt-3" aria-label="AI allowance"><div className="flex items-center justify-between gap-3"><span className="inline-flex items-center gap-2 text-xs font-medium"><Gauge className="size-4" aria-hidden="true" />AI allowance</span><span className="font-mono text-xs tabular-nums"><strong>{aiUsage.remaining_today}</strong>/{aiUsage.limits.requestsPerDayPerWallet}</span></div><p className="mt-1 truncate text-xs text-muted-foreground">Resets in {resetLabel(aiUsage.resets_at_ms)}{aiUsage.configured ? "" : " · API key pending"}</p></section> : null}
    </aside>
  </>;
}

export function ChatShell() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [workspaceKey, setWorkspaceKey] = useState(0);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedSpecialist, setSelectedSpecialist] = useState<Specialist | null>(null);
  const specialistTrigger = useRef<HTMLElement | null>(null);
  const [signedInWallet, setSignedInWallet] = useState<string | null>(null);
  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [aiUsage, setAiUsage] = useState<AiUsage | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [awaitingSignature, setAwaitingSignature] = useState(false);
  const [history, setHistory] = useState<Task[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [approvalInboxOpen, setApprovalInboxOpen] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [tokenBalances, setTokenBalances] = useState<TokenBalance[]>([]);
  const [balanceDialogOpen, setBalanceDialogOpen] = useState(false);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<Task | null>(null);
  const [deletingHistory, setDeletingHistory] = useState(false);
  const [deleteHistoryError, setDeleteHistoryError] = useState<string | null>(null);

  async function loadWalletData() { const [tasks, walletBalance, tokenValues, usage, pending] = await Promise.all([listTaskHistory(30), getWalletBalance(), getWalletTokenBalances(), getAiUsage(), listPendingApprovals()]); setHistory(tasks); setBalance(walletBalance); setTokenBalances(tokenValues); setAiUsage(usage); setApprovals(pending); setHistoryReady(true); }

  useEffect(() => { let active = true; void restoreWalletSession().then(async (session) => { if (!active) return; setSignedInWallet(session.owner_id); await loadWalletData(); }).catch(() => { if (active) setHistoryReady(true); }); return () => { active = false; }; }, []);

  useEffect(() => {
    if (!signedInWallet) return;
    const taskId = new URLSearchParams(window.location.search).get("task");
    if (!taskId) return;
    void getTask(taskId).then((task) => { setSelectedTask(task); setWorkspaceKey((value) => value + 1); window.history.replaceState({}, "", window.location.pathname); }).catch(() => setApprovalError("This checkpoint could not be opened for the connected wallet."));
  }, [signedInWallet]);

  useEffect(() => {
    if (!signedInWallet) return;
    let active = true;
    const refresh = () => { if (document.visibilityState !== "visible") return; void listPendingApprovals().then((pending) => { if (active) setApprovals(pending); }).catch(() => undefined); };
    const interval = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; window.clearInterval(interval); document.removeEventListener("visibilitychange", refresh); };
  }, [signedInWallet]);

  const signIn = useCallback(async (connectedAddress: string) => {
    setSigningIn(true); setAuthError(null);
    try { const provider = await connectWalletProvider(); const accounts = await connectedAccounts(); const address = accounts.find((value) => value.toLowerCase() === connectedAddress.toLowerCase()) ?? accounts[0]; if (!address) throw new Error("The wallet did not return an account."); const challenge = await createAuthChallenge(address); setAwaitingSignature(true); const signature = await withWalletTimeout(provider.request({ method: "personal_sign", params: [challenge.message, address] }) as Promise<string>, "No signature arrived from your wallet. Open MetaMask, approve the sign-in request, then try again.").finally(() => setAwaitingSignature(false)); const session = await verifyWalletSignature(address, signature); setAccessToken(session.access_token); setSignedInWallet(session.owner_id); await loadWalletData(); }
    catch (error) {
      await disconnectWalletProvider().catch(() => undefined);
      setAccessToken(null); setSignedInWallet(null); setBalance(null); setTokenBalances([]); setAiUsage(null); setHistory([]); setHistoryReady(true);
      setAuthError(walletConnectionMessage(error));
    }
    finally { setSigningIn(false); }
  }, []);

  async function signOut() { setSigningIn(true); setAuthError(null); try { await revokeWalletSession(); await disconnectWalletProvider(); } catch (error) { setAuthError(error instanceof Error ? error.message : "Server logout failed; the local session was cleared."); } finally { setAccessToken(null); setSignedInWallet(null); setBalance(null); setTokenBalances([]); setAiUsage(null); setHistory([]); setApprovals([]); setApprovalInboxOpen(false); setBalanceDialogOpen(false); setWalletMenuOpen(false); setDeleteCandidate(null); setDeleteHistoryError(null); setHistoryReady(true); setSigningIn(false); } }

  async function changeWallet() {
    setWalletMenuOpen(false);
    setSigningIn(true);
    setAuthError(null);
    try { await revokeWalletSession(); } catch { /* Local identity is cleared below even if server revocation is unavailable. */ }
    await disconnectWalletProvider().catch(() => undefined);
    setAccessToken(null); setSignedInWallet(null); setBalance(null); setTokenBalances([]); setAiUsage(null); setHistory([]); setApprovals([]); setHistoryReady(true);
    setSigningIn(false);
    window.setTimeout(() => {
      try { openWalletChooser(); }
      catch (error) { setAuthError(walletConnectionMessage(error)); }
    }, 0);
  }

  async function reviewApproval(approval: PendingApproval) {
    setApprovalError(null);
    try {
      const task = await getTask(approval.task_id);
      setSelectedTask(task);
      setWorkspaceKey((value) => value + 1);
      setApprovalInboxOpen(false);
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : "The checkpoint could not be opened.");
    }
  }

  function closeSpecialist() { setSelectedSpecialist(null); window.setTimeout(() => specialistTrigger.current?.focus(), 0); }

  async function confirmHistoryDeletion() {
    if (!deleteCandidate || deletingHistory) return;
    setDeletingHistory(true);
    setDeleteHistoryError(null);
    try {
      await deleteTaskHistory(deleteCandidate.id);
      setHistory((current) => current.filter((task) => task.id !== deleteCandidate.id));
      if (selectedTask?.id === deleteCandidate.id) {
        setSelectedTask(null);
        setWorkspaceKey((value) => value + 1);
      }
      setDeleteCandidate(null);
    } catch (error) {
      setDeleteHistoryError(error instanceof Error ? error.message : "Could not delete this history item. Try again.");
    } finally {
      setDeletingHistory(false);
    }
  }

  return <div className="donads-shell flex bg-background text-foreground">
    {signingIn ? <MascotLoader label={signedInWallet ? "Closing your wallet session…" : awaitingSignature ? "Approve the sign-in request in MetaMask…" : "Opening the wallet chooser…"} /> : null}
    {selectedSpecialist ? <SpecialistDialog specialist={selectedSpecialist} onClose={closeSpecialist} /> : null}
    {approvalInboxOpen ? <ApprovalDialog approvals={approvals} onClose={() => setApprovalInboxOpen(false)} onReview={(approval) => void reviewApproval(approval)} /> : null}
    {balanceDialogOpen && balance ? <BalanceDialog native={balance} tokens={tokenBalances} onClose={() => setBalanceDialogOpen(false)} /> : null}
    {walletMenuOpen && signedInWallet ? <WalletMenuDialog address={signedInWallet} working={signingIn} onChange={() => void changeWallet()} onDisconnect={() => void signOut()} onClose={() => setWalletMenuOpen(false)} /> : null}
    {deleteCandidate ? <DeleteHistoryDialog task={deleteCandidate} working={deletingHistory} error={deleteHistoryError} onClose={() => { if (!deletingHistory) { setDeleteCandidate(null); setDeleteHistoryError(null); } }} onConfirm={() => void confirmHistoryDeletion()} /> : null}
    <Sidebar open={sidebarOpen} history={history} historyReady={historyReady} aiUsage={aiUsage} onClose={() => setSidebarOpen(false)} onNewTask={() => { setSelectedTask(null); setWorkspaceKey((value) => value + 1); setSidebarOpen(false); }} onSpecialist={(specialist) => { specialistTrigger.current = document.activeElement as HTMLElement; setSelectedSpecialist(specialist); }} onHistory={(task) => { setSelectedTask(task); setWorkspaceKey((value) => value + 1); setSidebarOpen(false); }} onDeleteHistory={(task) => { setDeleteHistoryError(null); setDeleteCandidate(task); }} />
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex min-h-16 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-5 2xl:min-h-18 2xl:px-6">
        <button type="button" aria-label="Open navigation" onClick={() => setSidebarOpen(true)} className="grid size-10 place-items-center rounded-lg hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring lg:hidden"><Menu className="size-5" aria-hidden="true" /></button>
        <div className="hidden items-center gap-2 text-sm font-semibold sm:flex"><MascotMark size={28} /><span>Task workspace</span></div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {signedInWallet ? <button type="button" aria-label={`Open action inbox${approvals.length ? `, ${approvals.length} pending` : ""}`} onClick={() => setApprovalInboxOpen(true)} className="relative grid size-10 place-items-center rounded-full border border-border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"><Bell className="size-4" aria-hidden="true" />{approvals.length ? <span className="absolute -right-1 -top-1 grid min-h-5 min-w-5 place-items-center rounded-full bg-destructive px-1 font-mono text-[10px] font-semibold text-destructive-foreground">{Math.min(99, approvals.length)}</span> : null}</button> : null}
          {signedInWallet && balance ? <button type="button" aria-label="View Testnet token balances" onClick={() => setBalanceDialogOpen(true)} className="grid size-10 place-items-center rounded-full bg-muted text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:flex sm:w-auto sm:px-3"><Coins className="size-4 sm:hidden" aria-hidden="true" /><span className="hidden font-mono tabular-nums sm:inline">{Number(balance.balance_mon).toLocaleString(undefined, { maximumFractionDigits: 4 })} MON</span><span className="sr-only">Balances</span></button> : null}
          <WalletConnectControl signedInWallet={signedInWallet} signingIn={signingIn} onConnected={(address) => void signIn(address)} onManage={() => setWalletMenuOpen(true)} />
        </div>
      </header>
      {authError || approvalError ? <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-destructive/5 px-3 py-2 text-xs text-destructive sm:px-5"><span className="min-w-0 flex-1 leading-5">{authError ?? approvalError}</span><div className="ml-auto flex shrink-0 items-center gap-1">{authError ? <button type="button" onClick={() => { setAuthError(null); try { openWalletChooser(); } catch (error) { setAuthError(walletConnectionMessage(error)); } }} className="min-h-10 rounded-lg px-3 font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring">Choose another wallet</button> : null}<button type="button" aria-label="Dismiss wallet message" onClick={() => { setAuthError(null); setApprovalError(null); }} className="grid size-10 place-items-center rounded-lg hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring"><X className="size-4" aria-hidden="true" /></button></div></div> : null}
      <UnifiedTaskWorkspace key={workspaceKey} signedIn={Boolean(signedInWallet)} walletAddress={signedInWallet} aiConfigured={Boolean(aiUsage?.configured)} initialTask={selectedTask} addressSuggestions={taskAddressSuggestions(history, signedInWallet)} onTaskCompleted={() => void loadWalletData()} />
    </div>
  </div>;
}
