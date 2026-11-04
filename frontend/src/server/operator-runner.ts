import type { OperatorCompletedTask } from "@/lib/donads-api";
import { getTask, updateTask } from "@/server/database";
import { taskEvent } from "@/server/donads-types";
import { createAndExecuteTask } from "@/server/tasks";

export async function executeOperatorRun(ownerId: string, taskId: string): Promise<void> {
  "use step";
  const stored = await getTask(ownerId, taskId);
  if (!stored || stored.bot !== "operator" || stored.status.state !== "completed") throw new Error("Operator task not found.");
  const task = stored as OperatorCompletedTask;
  const workflow = task.status.data.workflow;
  workflow.state = "running";
  workflow.started_at_ms ??= Date.now();
  if (!workflow.audit_history.some((event) => event.event === "execution_started")) {
    workflow.audit_history.push({ sequence: workflow.audit_history.length + 1, event: "execution_started", detail: "Eligible specialist steps started in a durable Vercel workflow.", at_ms: Date.now() });
  }
  await updateTask(task);
  while (workflow.steps.some((step) => step.status === "pending")) {
    const refreshed = await getTask(ownerId, taskId) as OperatorCompletedTask | null;
    if (refreshed?.status.state === "completed" && refreshed.status.data.workflow.cancellation_requested) workflow.cancellation_requested = true;
    if (workflow.cancellation_requested) {
      workflow.steps.filter((step) => step.status === "pending").forEach((step) => { step.status = "cancelled"; });
      workflow.state = "cancelled";
      break;
    }
    const eligible = workflow.steps.filter((step) => step.status === "pending" && step.depends_on.every((dependency) => workflow.steps.find((candidate) => candidate.id === dependency)?.status === "completed"));
    const blocked = workflow.steps.filter((step) => step.status === "pending" && step.depends_on.some((dependency) => ["failed", "blocked", "cancelled"].includes(workflow.steps.find((candidate) => candidate.id === dependency)?.status ?? "")));
    blocked.forEach((step) => { step.status = "blocked"; step.error = "A required earlier step did not complete."; });
    if (!eligible.length) break;
    await Promise.all(eligible.map(async (step) => {
      step.status = "running";
      await updateTask(task);
      const child = await createAndExecuteTask(ownerId, { prompt: step.prompt, bot: step.bot, input: step.input });
      step.task_id = child.id;
      if (child.status.state === "completed") { step.status = "completed"; step.summary = child.status.summary; }
      else { step.status = "failed"; step.error = child.status.state === "failed" ? child.status.error : "Child task did not complete."; }
    }));
    task.updated_at_ms = Date.now();
    await updateTask(task);
  }
  const failed = workflow.steps.filter((step) => ["failed", "blocked"].includes(step.status)).length;
  if (workflow.state !== "cancelled") workflow.state = failed ? (failed === workflow.steps.length ? "failed" : "partial_failure") : "completed";
  workflow.completed_at_ms = Date.now();
  task.status.summary = failed ? `Operator finished with ${failed} failed or blocked step(s).` : `Operator completed all ${workflow.steps.length} specialist step(s).`;
  task.updated_at_ms = Date.now();
  task.events.push(taskEvent(task.events, workflow.state, task.status.summary));
  await updateTask(task);
}
