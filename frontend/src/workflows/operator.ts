import { executeOperatorRun } from "@/server/operator-runner";

export async function operatorWorkflow(ownerId: string, taskId: string): Promise<void> {
  "use workflow";
  await executeOperatorRun(ownerId, taskId);
}
