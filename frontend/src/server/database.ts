import { createHash, randomUUID } from "node:crypto";

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

import type { BrandProfile, OperatorRoutine, Task } from "@/lib/donads-api";
import type { Mission } from "@/lib/missions";
import { missionStateForTask, transactionIntentsForTask } from "@/lib/missions";
import type { UniswapQuote } from "@/server/uniswap";

type ChallengeRow = {
  address: string;
  message: string;
  expires_at_ms: string | number;
  consumed: boolean;
};

let client: NeonQueryFunction<false, false> | null = null;
let schemaReady: Promise<void> | null = null;

function connectionString(): string {
  const value = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!value) throw new Error("DATABASE_URL is not configured for DONADS.");
  return value;
}

export function sql(): NeonQueryFunction<false, false> {
  client ??= neon(connectionString());
  return client;
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    const db = sql();
    await db`CREATE TABLE IF NOT EXISTS donads_challenges (
      address TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      expires_at_ms BIGINT NOT NULL,
      consumed BOOLEAN NOT NULL DEFAULT FALSE
    )`;
    await db`CREATE TABLE IF NOT EXISTS donads_sessions (
      token_hash TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      expires_at_ms BIGINT NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at_ms BIGINT NOT NULL
    )`;
    await db`CREATE INDEX IF NOT EXISTS donads_sessions_owner_idx ON donads_sessions(owner_id)`;
    await db`CREATE TABLE IF NOT EXISTS donads_tasks (
      id UUID PRIMARY KEY,
      owner_id TEXT NOT NULL,
      title TEXT,
      prompt TEXT NOT NULL,
      bot TEXT NOT NULL,
      input JSONB NOT NULL,
      events JSONB NOT NULL,
      status JSONB NOT NULL,
      feedback JSONB,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )`;
    await db`ALTER TABLE donads_tasks ADD COLUMN IF NOT EXISTS title TEXT`;
    await db`ALTER TABLE donads_tasks ADD COLUMN IF NOT EXISTS deleted_at_ms BIGINT`;
    await db`CREATE INDEX IF NOT EXISTS donads_tasks_owner_updated_idx ON donads_tasks(owner_id, updated_at_ms DESC)`;
    await db`CREATE TABLE IF NOT EXISTS donads_missions (
      id UUID PRIMARY KEY,
      task_id UUID NOT NULL UNIQUE REFERENCES donads_tasks(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      specialist TEXT NOT NULL,
      state TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )`;
    await db`CREATE INDEX IF NOT EXISTS donads_missions_owner_updated_idx ON donads_missions(owner_id, updated_at_ms DESC)`;
    await db`CREATE TABLE IF NOT EXISTS donads_mission_events (
      mission_id UUID NOT NULL REFERENCES donads_missions(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      at_ms BIGINT NOT NULL,
      PRIMARY KEY(mission_id, sequence)
    )`;
    await db`CREATE TABLE IF NOT EXISTS donads_mission_steps (
      id UUID PRIMARY KEY,
      mission_id UUID NOT NULL REFERENCES donads_missions(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      specialist TEXT NOT NULL,
      title TEXT NOT NULL,
      state TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      started_at_ms BIGINT,
      completed_at_ms BIGINT,
      UNIQUE(mission_id, sequence),
      UNIQUE(owner_id, idempotency_key)
    )`;
    await db`CREATE TABLE IF NOT EXISTS donads_mission_attempts (
      id UUID PRIMARY KEY,
      mission_id UUID NOT NULL REFERENCES donads_missions(id) ON DELETE CASCADE,
      step_id UUID NOT NULL REFERENCES donads_mission_steps(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      state TEXT NOT NULL,
      started_at_ms BIGINT NOT NULL,
      completed_at_ms BIGINT,
      error_code TEXT,
      UNIQUE(step_id, attempt_number)
    )`;
    await db`CREATE TABLE IF NOT EXISTS donads_transaction_intents (
      id UUID PRIMARY KEY,
      mission_id UUID NOT NULL REFERENCES donads_missions(id) ON DELETE CASCADE,
      task_id UUID NOT NULL REFERENCES donads_tasks(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      asset TEXT NOT NULL,
      amount TEXT NOT NULL,
      amount_atomic TEXT,
      token_contract TEXT,
      calldata_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at_ms BIGINT NOT NULL,
      UNIQUE(owner_id, idempotency_key)
    )`;
    await db`CREATE TABLE IF NOT EXISTS donads_mission_approvals (
      intent_id UUID PRIMARY KEY REFERENCES donads_transaction_intents(id) ON DELETE CASCADE,
      mission_id UUID NOT NULL REFERENCES donads_missions(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      state TEXT NOT NULL,
      evidence JSONB,
      updated_at_ms BIGINT NOT NULL
    )`;
    await db`CREATE TABLE IF NOT EXISTS donads_transaction_receipts (
      intent_id UUID PRIMARY KEY REFERENCES donads_transaction_intents(id) ON DELETE CASCADE,
      mission_id UUID NOT NULL REFERENCES donads_missions(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,
      transaction_hash TEXT NOT NULL,
      block_number BIGINT NOT NULL,
      verified_at_ms BIGINT NOT NULL,
      evidence JSONB NOT NULL
    )`;
    await db`CREATE TABLE IF NOT EXISTS donads_profiles (
      owner_id TEXT NOT NULL,
      id TEXT NOT NULL,
      data JSONB NOT NULL,
      PRIMARY KEY(owner_id, id)
    )`;
    await db`CREATE TABLE IF NOT EXISTS donads_routines (
      owner_id TEXT NOT NULL,
      id TEXT NOT NULL,
      data JSONB NOT NULL,
      PRIMARY KEY(owner_id, id)
    )`;
    await db`CREATE TABLE IF NOT EXISTS donads_rate_limits (
      key_hash TEXT NOT NULL,
      window_start_ms BIGINT NOT NULL,
      requests INTEGER NOT NULL,
      PRIMARY KEY(key_hash, window_start_ms)
    )`;
    await db`CREATE TABLE IF NOT EXISTS donads_ai_leases (
      owner_id TEXT PRIMARY KEY,
      request_id UUID NOT NULL,
      expires_at_ms BIGINT NOT NULL
    )`;
    await db`CREATE TABLE IF NOT EXISTS donads_ai_usage (
      request_id UUID PRIMARY KEY,
      owner_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at_ms BIGINT NOT NULL
    )`;
    await db`CREATE INDEX IF NOT EXISTS donads_ai_usage_owner_created_idx ON donads_ai_usage(owner_id, created_at_ms DESC)`;
    await db`CREATE TABLE IF NOT EXISTS donads_push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      subscription JSONB NOT NULL,
      created_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )`;
    await db`CREATE INDEX IF NOT EXISTS donads_push_subscriptions_owner_idx ON donads_push_subscriptions(owner_id)`;
    await db`CREATE TABLE IF NOT EXISTS donads_telegram_link_codes (
      code_hash TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      expires_at_ms BIGINT NOT NULL,
      consumed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at_ms BIGINT NOT NULL
    )`;
    await db`CREATE INDEX IF NOT EXISTS donads_telegram_link_codes_owner_idx ON donads_telegram_link_codes(owner_id)`;
    await db`CREATE TABLE IF NOT EXISTS donads_telegram_links (
      owner_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL UNIQUE,
      username TEXT,
      linked_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )`;
    await db`CREATE TABLE IF NOT EXISTS donads_telegram_updates (
      update_id BIGINT PRIMARY KEY,
      received_at_ms BIGINT NOT NULL
    )`;
    await db`CREATE TABLE IF NOT EXISTS donads_offer_proposals (
      proposal_id UUID PRIMARY KEY,
      owner_id TEXT NOT NULL,
      offer_id TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'pending',
      created_at_ms BIGINT NOT NULL,
      decided_at_ms BIGINT
    )`;
    await db`CREATE INDEX IF NOT EXISTS donads_offer_proposals_owner_idx ON donads_offer_proposals(owner_id, created_at_ms DESC)`;
    await db`CREATE TABLE IF NOT EXISTS donads_schedules (
      schedule_id UUID PRIMARY KEY,
      owner_id TEXT NOT NULL,
      recipients JSONB NOT NULL,
      amount_each TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      next_run_ms BIGINT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      runs INTEGER NOT NULL DEFAULT 0,
      last_task_id TEXT,
      created_at_ms BIGINT NOT NULL
    )`;
    await db`CREATE INDEX IF NOT EXISTS donads_schedules_due_idx ON donads_schedules(active, next_run_ms)`;
    await db`CREATE TABLE IF NOT EXISTS donads_swap_quotes (
      quote_id UUID PRIMARY KEY,
      owner_id TEXT NOT NULL,
      data JSONB NOT NULL,
      state TEXT NOT NULL,
      expires_at_ms BIGINT NOT NULL,
      updated_at_ms BIGINT NOT NULL
    )`;
    await db`CREATE INDEX IF NOT EXISTS donads_swap_quotes_owner_idx ON donads_swap_quotes(owner_id, updated_at_ms DESC)`;
  })();
  return schemaReady;
}

export async function putChallenge(address: string, message: string, expiresAtMs: number) {
  await ensureSchema();
  const db = sql();
  await db`INSERT INTO donads_challenges(address, message, expires_at_ms, consumed)
    VALUES (${address}, ${message}, ${expiresAtMs}, FALSE)
    ON CONFLICT(address) DO UPDATE SET message = EXCLUDED.message, expires_at_ms = EXCLUDED.expires_at_ms, consumed = FALSE`;
}

export async function getChallenge(address: string): Promise<ChallengeRow | null> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT address, message, expires_at_ms, consumed FROM donads_challenges
    WHERE address = ${address} AND consumed = FALSE AND expires_at_ms > ${Date.now()} LIMIT 1` as ChallengeRow[];
  return rows[0] ?? null;
}

export async function consumeChallenge(address: string, message: string): Promise<boolean> {
  await ensureSchema();
  const db = sql();
  const rows = await db`UPDATE donads_challenges SET consumed = TRUE
    WHERE address = ${address} AND message = ${message} AND consumed = FALSE AND expires_at_ms > ${Date.now()}
    RETURNING address` as Array<{ address: string }>;
  return rows.length === 1;
}

export async function takeRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
  await ensureSchema();
  const db = sql();
  const keyHash = createHash("sha256").update(key).digest("hex");
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const rows = await db`INSERT INTO donads_rate_limits(key_hash, window_start_ms, requests)
    VALUES (${keyHash}, ${windowStart}, 1)
    ON CONFLICT(key_hash, window_start_ms) DO UPDATE SET requests = donads_rate_limits.requests + 1
    RETURNING requests` as Array<{ requests: number }>;
  return Number(rows[0]?.requests ?? limit + 1) <= limit;
}

export async function acquireAiLease(ownerId: string, requestId: string, expiresAtMs: number): Promise<boolean> {
  await ensureSchema();
  const db = sql();
  const rows = await db`INSERT INTO donads_ai_leases(owner_id, request_id, expires_at_ms)
    VALUES (${ownerId}, ${requestId}, ${expiresAtMs})
    ON CONFLICT(owner_id) DO UPDATE SET request_id = EXCLUDED.request_id, expires_at_ms = EXCLUDED.expires_at_ms
    WHERE donads_ai_leases.expires_at_ms <= ${Date.now()}
    RETURNING owner_id` as Array<{ owner_id: string }>;
  return rows.length === 1;
}

export async function releaseAiLease(ownerId: string, requestId: string): Promise<void> {
  await ensureSchema();
  const db = sql();
  await db`DELETE FROM donads_ai_leases WHERE owner_id = ${ownerId} AND request_id = ${requestId}`;
}

export async function recordAiUsage(input: { requestId: string; ownerId: string; provider: string; model: string; inputTokens: number; outputTokens: number; status: string }): Promise<void> {
  await ensureSchema();
  const db = sql();
  await db`INSERT INTO donads_ai_usage(request_id, owner_id, provider, model, input_tokens, output_tokens, status, created_at_ms)
    VALUES (${input.requestId}, ${input.ownerId}, ${input.provider}, ${input.model}, ${input.inputTokens}, ${input.outputTokens}, ${input.status}, ${Date.now()})
    ON CONFLICT(request_id) DO UPDATE SET input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens, status = EXCLUDED.status`;
}

export async function getAiUsageSince(ownerId: string, sinceMs: number): Promise<number> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT COUNT(*)::int AS requests FROM donads_ai_usage
    WHERE owner_id = ${ownerId} AND created_at_ms >= ${sinceMs}` as Array<{ requests: number }>;
  return Number(rows[0]?.requests ?? 0);
}

export async function createSession(token: string, ownerId: string, expiresAtMs: number) {
  await ensureSchema();
  const db = sql();
  await db`INSERT INTO donads_sessions(token_hash, owner_id, expires_at_ms, revoked, created_at_ms)
    VALUES (${tokenHash(token)}, ${ownerId}, ${expiresAtMs}, FALSE, ${Date.now()})`;
}

export async function sessionOwner(token: string): Promise<string | null> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT owner_id FROM donads_sessions
    WHERE token_hash = ${tokenHash(token)} AND revoked = FALSE AND expires_at_ms > ${Date.now()}
    LIMIT 1` as Array<{ owner_id: string }>;
  return rows[0]?.owner_id ?? null;
}

export async function revokeSession(token: string): Promise<void> {
  await ensureSchema();
  const db = sql();
  await db`UPDATE donads_sessions SET revoked = TRUE WHERE token_hash = ${tokenHash(token)}`;
}

export async function insertTask(task: Task): Promise<void> {
  await ensureSchema();
  const db = sql();
  const missionId = randomUUID();
  const stepId = randomUUID();
  const attemptId = randomUUID();
  const firstEvent = task.events[0];
  await db.transaction([
    db`INSERT INTO donads_tasks(id, owner_id, title, prompt, bot, input, events, status, feedback, created_at_ms, updated_at_ms)
      VALUES (${task.id}, ${task.owner_id}, ${task.title ?? task.prompt.slice(0, 58)}, ${task.prompt}, ${task.bot}, ${JSON.stringify(task.input)}, ${JSON.stringify(task.events)}, ${JSON.stringify(task.status)}, ${JSON.stringify(task.feedback)}, ${task.created_at_ms}, ${task.updated_at_ms})`,
    db`INSERT INTO donads_missions(id, task_id, owner_id, objective, specialist, state, version, created_at_ms, updated_at_ms)
      VALUES (${missionId}, ${task.id}, ${task.owner_id}, ${task.prompt}, ${task.bot}, 'running', 1, ${task.created_at_ms}, ${task.updated_at_ms})`,
    db`INSERT INTO donads_mission_events(mission_id, owner_id, sequence, kind, message, at_ms)
      VALUES (${missionId}, ${task.owner_id}, 1, ${firstEvent?.kind ?? "queued"}, ${firstEvent?.message ?? "Mission accepted."}, ${firstEvent?.at_ms ?? task.created_at_ms})`,
    db`INSERT INTO donads_mission_steps(id, mission_id, owner_id, sequence, specialist, title, state, idempotency_key, started_at_ms)
      VALUES (${stepId}, ${missionId}, ${task.owner_id}, 1, ${task.bot}, ${task.prompt}, 'running', ${`task:${task.id}:step:1`}, ${task.created_at_ms})`,
    db`INSERT INTO donads_mission_attempts(id, mission_id, step_id, owner_id, attempt_number, state, started_at_ms)
      VALUES (${attemptId}, ${missionId}, ${stepId}, ${task.owner_id}, 1, 'running', ${task.created_at_ms})`,
  ]);
}

export async function updateTask(task: Task): Promise<void> {
  await ensureSchema();
  const db = sql();
  const state = missionStateForTask(task);
  const event = task.events.at(-1) ?? { kind: "updated", message: "Mission updated.", at_ms: task.updated_at_ms };
  const terminal = ["completed", "failed", "cancelled"].includes(state);
  const intents = transactionIntentsForTask(task);
  const queries = [
    db`UPDATE donads_tasks SET events = ${JSON.stringify(task.events)}, status = ${JSON.stringify(task.status)},
      feedback = ${JSON.stringify(task.feedback)}, updated_at_ms = ${task.updated_at_ms}
      WHERE id = ${task.id} AND owner_id = ${task.owner_id}`,
    db`WITH advanced AS (
        UPDATE donads_missions SET state = ${state}, version = version + 1, updated_at_ms = ${task.updated_at_ms}
        WHERE task_id = ${task.id} AND owner_id = ${task.owner_id}
        RETURNING id, owner_id, version
      )
      INSERT INTO donads_mission_events(mission_id, owner_id, sequence, kind, message, at_ms)
      SELECT id, owner_id, version, ${event.kind}, ${event.message}, ${event.at_ms} FROM advanced
      ON CONFLICT(mission_id, sequence) DO NOTHING`,
    db`UPDATE donads_mission_steps SET state = ${state}, completed_at_ms = ${terminal ? task.updated_at_ms : null}
      WHERE mission_id = (SELECT id FROM donads_missions WHERE task_id = ${task.id} AND owner_id = ${task.owner_id}) AND sequence = 1`,
    db`UPDATE donads_mission_attempts SET state = ${state}, completed_at_ms = ${terminal ? task.updated_at_ms : null},
      error_code = ${task.status.state === "failed" ? "SPECIALIST_FAILED" : null}
      WHERE mission_id = (SELECT id FROM donads_missions WHERE task_id = ${task.id} AND owner_id = ${task.owner_id}) AND attempt_number = 1`,
  ];
  for (const intent of intents) {
    queries.push(db`INSERT INTO donads_transaction_intents(
        id, mission_id, task_id, owner_id, kind, chain_id, sender, recipient, asset, amount,
        amount_atomic, token_contract, calldata_hash, state, idempotency_key, data, updated_at_ms
      ) SELECT ${intent.id}, id, ${task.id}, ${task.owner_id}, ${intent.kind}, ${intent.chain_id}, ${intent.sender},
        ${intent.recipient}, ${intent.asset}, ${intent.amount}, ${intent.amount_atomic}, ${intent.token_contract},
        ${intent.calldata_hash}, ${intent.state}, ${intent.idempotency_key}, ${JSON.stringify(intent)}, ${task.updated_at_ms}
      FROM donads_missions WHERE task_id = ${task.id} AND owner_id = ${task.owner_id}
      ON CONFLICT(id) DO UPDATE SET state = EXCLUDED.state, data = EXCLUDED.data, updated_at_ms = EXCLUDED.updated_at_ms`);
    if (intent.approval) {
      queries.push(db`INSERT INTO donads_mission_approvals(intent_id, mission_id, owner_id, state, evidence, updated_at_ms)
        SELECT ${intent.id}, id, ${task.owner_id}, ${intent.state}, ${JSON.stringify(intent.approval)}, ${task.updated_at_ms}
        FROM donads_missions WHERE task_id = ${task.id} AND owner_id = ${task.owner_id}
        ON CONFLICT(intent_id) DO UPDATE SET state = EXCLUDED.state, evidence = EXCLUDED.evidence, updated_at_ms = EXCLUDED.updated_at_ms`);
    }
    const execution = intent.execution as { transaction_hash?: string; block_number?: number; confirmed_at_ms?: number } | null;
    if (execution?.transaction_hash && execution.block_number !== undefined && execution.confirmed_at_ms) {
      queries.push(db`INSERT INTO donads_transaction_receipts(intent_id, mission_id, owner_id, transaction_hash, block_number, verified_at_ms, evidence)
        SELECT ${intent.id}, id, ${task.owner_id}, ${execution.transaction_hash}, ${execution.block_number}, ${execution.confirmed_at_ms}, ${JSON.stringify(execution)}
        FROM donads_missions WHERE task_id = ${task.id} AND owner_id = ${task.owner_id}
        ON CONFLICT(intent_id) DO UPDATE SET transaction_hash = EXCLUDED.transaction_hash, block_number = EXCLUDED.block_number,
          verified_at_ms = EXCLUDED.verified_at_ms, evidence = EXCLUDED.evidence`);
    }
  }
  await db.transaction(queries);
}

export async function getMission(ownerId: string, id: string): Promise<Mission | null> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT id::text, task_id::text, owner_id, objective, specialist, state, version, created_at_ms, updated_at_ms
    FROM donads_missions WHERE id = ${id} AND owner_id = ${ownerId} LIMIT 1` as Array<Record<string, unknown>>;
  if (!rows[0]) return null;
  return hydrateMission(db, rows[0]);
}

export async function listMissions(ownerId: string, limit: number): Promise<Mission[]> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT id::text, task_id::text, owner_id, objective, specialist, state, version, created_at_ms, updated_at_ms
    FROM donads_missions WHERE owner_id = ${ownerId} ORDER BY updated_at_ms DESC LIMIT ${limit}` as Array<Record<string, unknown>>;
  return Promise.all(rows.map((row) => hydrateMission(db, row)));
}

export async function countVerifiedTestnetReceipts(ownerId: string): Promise<number> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT COUNT(*)::int AS receipts FROM donads_transaction_receipts WHERE owner_id = ${ownerId}` as Array<{ receipts: number }>;
  return Number(rows[0]?.receipts ?? 0);
}

async function hydrateMission(db: NeonQueryFunction<false, false>, row: Record<string, unknown>): Promise<Mission> {
  const events = await db`SELECT sequence, kind, message, at_ms FROM donads_mission_events
    WHERE mission_id = ${String(row.id)} AND owner_id = ${String(row.owner_id)} ORDER BY sequence ASC` as Array<Record<string, unknown>>;
  return {
    id: String(row.id), task_id: String(row.task_id), owner_id: String(row.owner_id), objective: String(row.objective),
    specialist: String(row.specialist), state: String(row.state) as Mission["state"], version: Number(row.version),
    created_at_ms: Number(row.created_at_ms), updated_at_ms: Number(row.updated_at_ms),
    events: events.map((event) => ({ sequence: Number(event.sequence), kind: String(event.kind), message: String(event.message), at_ms: Number(event.at_ms) })),
  };
}

export async function getTask(ownerId: string, id: string): Promise<Task | null> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT id::text, owner_id, title, prompt, bot, input, events, status, feedback, created_at_ms, updated_at_ms
    FROM donads_tasks WHERE id = ${id} AND owner_id = ${ownerId} AND deleted_at_ms IS NULL LIMIT 1` as Array<Record<string, unknown>>;
  return rows[0] ? hydrateTask(rows[0]) : null;
}

export async function listTasks(ownerId: string, limit: number): Promise<Task[]> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT id::text, owner_id, title, prompt, bot, input, events, status, feedback, created_at_ms, updated_at_ms
    FROM donads_tasks WHERE owner_id = ${ownerId} AND deleted_at_ms IS NULL ORDER BY updated_at_ms DESC LIMIT ${limit}` as Array<Record<string, unknown>>;
  return rows.map(hydrateTask);
}

export async function deleteTaskHistory(ownerId: string, id: string): Promise<boolean> {
  await ensureSchema();
  const db = sql();
  const rows = await db`UPDATE donads_tasks SET deleted_at_ms = ${Date.now()}
    WHERE id = ${id} AND owner_id = ${ownerId} AND deleted_at_ms IS NULL
    RETURNING id` as Array<{ id: string }>;
  return rows.length === 1;
}

function hydrateTask(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    owner_id: String(row.owner_id),
    title: row.title ? String(row.title) : undefined,
    prompt: String(row.prompt),
    bot: String(row.bot),
    input: row.input,
    events: row.events as Task["events"],
    status: row.status as Task["status"],
    feedback: (row.feedback ?? null) as Task["feedback"],
    created_at_ms: Number(row.created_at_ms),
    updated_at_ms: Number(row.updated_at_ms),
  } as Task;
}

export async function putProfile(ownerId: string, profile: BrandProfile): Promise<void> {
  await ensureSchema();
  const db = sql();
  await db`INSERT INTO donads_profiles(owner_id, id, data) VALUES (${ownerId}, ${profile.id}, ${JSON.stringify(profile)})
    ON CONFLICT(owner_id, id) DO UPDATE SET data = EXCLUDED.data`;
}

export async function getProfile(ownerId: string, id: string): Promise<BrandProfile | null> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT data FROM donads_profiles WHERE owner_id = ${ownerId} AND id = ${id} LIMIT 1` as Array<{ data: BrandProfile }>;
  return rows[0]?.data ?? null;
}

export async function putRoutine(ownerId: string, routine: OperatorRoutine): Promise<void> {
  await ensureSchema();
  const db = sql();
  await db`INSERT INTO donads_routines(owner_id, id, data) VALUES (${ownerId}, ${routine.id}, ${JSON.stringify(routine)})
    ON CONFLICT(owner_id, id) DO UPDATE SET data = EXCLUDED.data`;
}

export async function getRoutine(ownerId: string, id: string): Promise<OperatorRoutine | null> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT data FROM donads_routines WHERE owner_id = ${ownerId} AND id = ${id} LIMIT 1` as Array<{ data: OperatorRoutine }>;
  return rows[0]?.data ?? null;
}

export async function listRoutines(ownerId: string): Promise<OperatorRoutine[]> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT data FROM donads_routines WHERE owner_id = ${ownerId} ORDER BY (data->>'updated_at_ms')::bigint DESC` as Array<{ data: OperatorRoutine }>;
  return rows.map((row) => row.data);
}
export async function putTelegramLinkCode(ownerId: string, codeHash: string, expiresAtMs: number): Promise<void> {
  await ensureSchema();
  const db = sql();
  await db`DELETE FROM donads_telegram_link_codes WHERE owner_id = ${ownerId} OR expires_at_ms <= ${Date.now()}`;
  await db`INSERT INTO donads_telegram_link_codes(code_hash, owner_id, expires_at_ms, consumed, created_at_ms)
    VALUES (${codeHash}, ${ownerId}, ${expiresAtMs}, FALSE, ${Date.now()})`;
}

export async function consumeTelegramLinkCode(codeHash: string, chatId: string, username: string | null): Promise<string | null> {
  await ensureSchema();
  const db = sql();
  const rows = await db`WITH claimed AS (
      UPDATE donads_telegram_link_codes SET consumed = TRUE
      WHERE code_hash = ${codeHash} AND consumed = FALSE AND expires_at_ms > ${Date.now()}
      RETURNING owner_id
    ), removed_chat AS (
      DELETE FROM donads_telegram_links WHERE chat_id = ${chatId}
    )
    INSERT INTO donads_telegram_links(owner_id, chat_id, username, linked_at_ms, updated_at_ms)
      SELECT owner_id, ${chatId}, ${username}, ${Date.now()}, ${Date.now()} FROM claimed
    ON CONFLICT(owner_id) DO UPDATE SET chat_id = EXCLUDED.chat_id, username = EXCLUDED.username, updated_at_ms = EXCLUDED.updated_at_ms
    RETURNING owner_id` as Array<{ owner_id: string }>;
  return rows[0]?.owner_id ?? null;
}

export async function getTelegramLink(ownerId: string): Promise<{ chat_id: string; username: string | null; linked_at_ms: number } | null> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT chat_id, username, linked_at_ms FROM donads_telegram_links WHERE owner_id = ${ownerId} LIMIT 1` as Array<{ chat_id: string; username: string | null; linked_at_ms: string | number }>;
  const row = rows[0];
  return row ? { chat_id: row.chat_id, username: row.username, linked_at_ms: Number(row.linked_at_ms) } : null;
}

export async function getTelegramOwner(chatId: string): Promise<string | null> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT owner_id FROM donads_telegram_links WHERE chat_id = ${chatId} LIMIT 1` as Array<{ owner_id: string }>;
  return rows[0]?.owner_id ?? null;
}

export async function deleteTelegramLink(ownerId: string): Promise<void> {
  await ensureSchema();
  const db = sql();
  await db`DELETE FROM donads_telegram_links WHERE owner_id = ${ownerId}`;
  await db`DELETE FROM donads_telegram_link_codes WHERE owner_id = ${ownerId}`;
}

export async function claimTelegramUpdate(updateId: number): Promise<boolean> {
  await ensureSchema();
  const db = sql();
  const rows = await db`INSERT INTO donads_telegram_updates(update_id, received_at_ms)
    VALUES (${updateId}, ${Date.now()}) ON CONFLICT(update_id) DO NOTHING RETURNING update_id` as Array<{ update_id: string | number }>;
  return rows.length === 1;
}

export async function putSwapQuote(ownerId: string, quote: UniswapQuote): Promise<void> {
  await ensureSchema();
  const db = sql();
  await db`INSERT INTO donads_swap_quotes(quote_id, owner_id, data, state, expires_at_ms, updated_at_ms)
    VALUES (${quote.quote_id}, ${ownerId}, ${JSON.stringify(quote)}, 'quoted', ${quote.expires_at_ms}, ${Date.now()})`;
}

export async function getSwapQuote(ownerId: string, quoteId: string): Promise<UniswapQuote | null> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT data FROM donads_swap_quotes WHERE quote_id = ${quoteId} AND owner_id = ${ownerId} LIMIT 1` as Array<{ data: UniswapQuote }>;
  return rows[0]?.data ?? null;
}

export async function completeSwapQuote(ownerId: string, quote: UniswapQuote): Promise<void> {
  await ensureSchema();
  const db = sql();
  await db`UPDATE donads_swap_quotes SET data = ${JSON.stringify(quote)}, state = 'confirmed', updated_at_ms = ${Date.now()}
    WHERE quote_id = ${quote.quote_id} AND owner_id = ${ownerId} AND state = 'quoted'`;
}

export type OfferProposal = { proposal_id: string; offer_id: string; decision: "pending" | "go" | "skip"; created_at_ms: number; decided_at_ms: number | null };

export async function putOfferProposal(ownerId: string, proposalId: string, offerId: string): Promise<void> {
  await ensureSchema();
  const db = sql();
  await db`INSERT INTO donads_offer_proposals(proposal_id, owner_id, offer_id, decision, created_at_ms) VALUES (${proposalId}, ${ownerId}, ${offerId}, 'pending', ${Date.now()})`;
}

export async function getOfferProposal(ownerId: string, proposalId: string): Promise<OfferProposal | null> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT proposal_id, offer_id, decision, created_at_ms, decided_at_ms FROM donads_offer_proposals WHERE owner_id = ${ownerId} AND proposal_id = ${proposalId} LIMIT 1` as Array<{ proposal_id: string; offer_id: string; decision: OfferProposal["decision"]; created_at_ms: string | number; decided_at_ms: string | number | null }>;
  const row = rows[0];
  return row ? { proposal_id: row.proposal_id, offer_id: row.offer_id, decision: row.decision, created_at_ms: Number(row.created_at_ms), decided_at_ms: row.decided_at_ms === null ? null : Number(row.decided_at_ms) } : null;
}

/** Records Go or Skip once; returns the offer id, or null if not pending or not owned. */
export async function decideOfferProposal(ownerId: string, proposalId: string, decision: "go" | "skip"): Promise<string | null> {
  await ensureSchema();
  const db = sql();
  const rows = await db`UPDATE donads_offer_proposals SET decision = ${decision}, decided_at_ms = ${Date.now()}
    WHERE owner_id = ${ownerId} AND proposal_id = ${proposalId} AND decision = 'pending' RETURNING offer_id` as Array<{ offer_id: string }>;
  return rows[0]?.offer_id ?? null;
}

export type PaymentSchedule = {
  schedule_id: string; owner_id: string; recipients: string[]; amount_each: string; interval_minutes: number;
  next_run_ms: number; active: boolean; runs: number; last_task_id: string | null; created_at_ms: number;
};

type ScheduleRow = Omit<PaymentSchedule, "next_run_ms" | "created_at_ms" | "recipients"> & { recipients: unknown; next_run_ms: string | number; created_at_ms: string | number };

function scheduleFromRow(row: ScheduleRow): PaymentSchedule {
  return { ...row, recipients: Array.isArray(row.recipients) ? row.recipients.map(String) : [], next_run_ms: Number(row.next_run_ms), created_at_ms: Number(row.created_at_ms) };
}

export async function putSchedule(schedule: PaymentSchedule): Promise<void> {
  await ensureSchema();
  const db = sql();
  await db`INSERT INTO donads_schedules(schedule_id, owner_id, recipients, amount_each, interval_minutes, next_run_ms, active, runs, last_task_id, created_at_ms)
    VALUES (${schedule.schedule_id}, ${schedule.owner_id}, ${JSON.stringify(schedule.recipients)}::jsonb, ${schedule.amount_each}, ${schedule.interval_minutes}, ${schedule.next_run_ms}, ${schedule.active}, ${schedule.runs}, ${schedule.last_task_id}, ${schedule.created_at_ms})`;
}

export async function listSchedules(ownerId: string): Promise<PaymentSchedule[]> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT * FROM donads_schedules WHERE owner_id = ${ownerId} ORDER BY created_at_ms DESC LIMIT 50` as ScheduleRow[];
  return rows.map(scheduleFromRow);
}

export async function countActiveSchedules(ownerId: string): Promise<number> {
  await ensureSchema();
  const db = sql();
  const rows = await db`SELECT COUNT(*)::int AS count FROM donads_schedules WHERE owner_id = ${ownerId} AND active = TRUE` as Array<{ count: number }>;
  return Number(rows[0]?.count ?? 0);
}

export async function stopSchedules(ownerId: string): Promise<number> {
  await ensureSchema();
  const db = sql();
  const rows = await db`UPDATE donads_schedules SET active = FALSE WHERE owner_id = ${ownerId} AND active = TRUE RETURNING schedule_id` as Array<{ schedule_id: string }>;
  return rows.length;
}

/** Claims due schedules by moving next_run forward first, so concurrent runners cannot double-run. */
export async function claimDueSchedules(now: number, limit = 20): Promise<PaymentSchedule[]> {
  await ensureSchema();
  const db = sql();
  const rows = await db`UPDATE donads_schedules SET next_run_ms = ${now} + interval_minutes::bigint * 60000, runs = runs + 1
    WHERE schedule_id IN (SELECT schedule_id FROM donads_schedules WHERE active = TRUE AND next_run_ms <= ${now} ORDER BY next_run_ms LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING *` as ScheduleRow[];
  return rows.map(scheduleFromRow);
}

export async function setScheduleLastTask(scheduleId: string, taskId: string): Promise<void> {
  await ensureSchema();
  const db = sql();
  await db`UPDATE donads_schedules SET last_task_id = ${taskId} WHERE schedule_id = ${scheduleId}`;
}
