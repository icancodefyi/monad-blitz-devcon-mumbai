//! Durable, permission-bounded orchestration plans for DONADS specialists.

use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use donads_core::{Bot, BotDescriptor, BotError, BotResult, Task};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use uuid::Uuid;

pub const AGENT_VERSION: &str = "operator-orchestration-v2";
const MAX_STEPS: usize = 10;
const ALLOWED_BOTS: [&str; 4] = ["scout", "growth", "flow", "commerce"];

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OperatorInput {
    pub objective: String,
    pub target_date: Option<String>,
    pub steps: Vec<OperatorStepInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OperatorStepInput {
    pub id: String,
    pub title: String,
    pub bot: String,
    pub prompt: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperatorState {
    Planned,
    Running,
    Cancelling,
    Completed,
    PartialFailure,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperatorStepStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Blocked,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OperatorStep {
    pub id: String,
    pub order: u8,
    pub title: String,
    pub bot: String,
    pub prompt: String,
    pub input: Value,
    pub depends_on: Vec<String>,
    pub status: OperatorStepStatus,
    pub task_id: Option<Uuid>,
    pub summary: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OperatorAuditEvent {
    pub sequence: u32,
    pub event: String,
    pub detail: String,
    pub at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OperatorWorkflow {
    pub id: String,
    pub objective: String,
    pub target_date: Option<String>,
    pub state: OperatorState,
    pub steps: Vec<OperatorStep>,
    pub cancellation_requested: bool,
    pub started_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub audit_history: Vec<OperatorAuditEvent>,
    pub permissions: OperatorPermissions,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[allow(clippy::struct_excessive_bools)] // Explicit serialized denials make each safety boundary independently auditable.
pub struct OperatorPermissions {
    pub external_writes: bool,
    pub publishing_available: bool,
    pub signing_available: bool,
    pub fund_movement_available: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum OperatorAction {
    Start,
    Cancel,
    RetryFailed,
}

#[derive(Debug, Error)]
pub enum OperatorTransitionError {
    #[error("invalid Operator action: {0}")]
    InvalidAction(String),
    #[error("Operator action conflicts with current state: {0}")]
    Conflict(String),
}

#[derive(Default)]
pub struct Operator;

#[async_trait]
impl Bot for Operator {
    fn descriptor(&self) -> BotDescriptor {
        BotDescriptor {
            id: "operator",
            name: "Operator",
            specialty: "Dependency-aware coordination of approved DONADS specialists",
            available: true,
        }
    }

    async fn execute(&self, task: &Task) -> Result<BotResult, BotError> {
        let input: OperatorInput = serde_json::from_value(task.input.clone()).map_err(|error| {
            BotError::InvalidInput(format!(
                "Operator requires a structured orchestration brief: {error}"
            ))
        })?;
        let workflow = build_workflow(&input, task.id)?;
        let summary = format!(
            "Operator prepared {} dependency-ordered step(s). Review the plan before starting it.",
            workflow.steps.len()
        );
        Ok(BotResult {
            summary,
            data: json!({
                "workflow": workflow,
                "agent_version": AGENT_VERSION,
                "external_actions": false
            }),
        })
    }
}

/// Builds a validated, non-executing orchestration plan.
///
/// # Errors
///
/// Returns [`BotError::InvalidInput`] when the objective, steps, specialists,
/// identifiers, or dependency ordering are invalid.
pub fn build_workflow(input: &OperatorInput, task_id: Uuid) -> Result<OperatorWorkflow, BotError> {
    validate_input(input)?;
    let steps = input
        .steps
        .iter()
        .enumerate()
        .map(|(index, step)| OperatorStep {
            id: step.id.clone(),
            order: u8::try_from(index + 1).unwrap_or(u8::MAX),
            title: step.title.trim().to_owned(),
            bot: step.bot.clone(),
            prompt: step.prompt.trim().to_owned(),
            input: step.input.clone(),
            depends_on: step.depends_on.clone(),
            status: OperatorStepStatus::Pending,
            task_id: None,
            summary: None,
            error: None,
        })
        .collect();
    Ok(OperatorWorkflow {
        id: format!("operator-{task_id}"),
        objective: input.objective.trim().to_owned(),
        target_date: input.target_date.clone(),
        state: OperatorState::Planned,
        steps,
        cancellation_requested: false,
        started_at_ms: None,
        completed_at_ms: None,
        audit_history: vec![OperatorAuditEvent {
            sequence: 1,
            event: "plan_created".into(),
            detail: "Dependency graph validated; awaiting explicit start.".into(),
            at_ms: unix_time_ms(),
        }],
        permissions: OperatorPermissions {
            external_writes: false,
            publishing_available: false,
            signing_available: false,
            fund_movement_available: false,
        },
    })
}

/// Applies one user-approved control action to an Operator workflow.
///
/// # Errors
///
/// Returns [`OperatorTransitionError`] when the action is not valid for the
/// workflow state or there are no incomplete steps to retry.
pub fn apply_action(
    workflow: &mut OperatorWorkflow,
    action: OperatorAction,
) -> Result<String, OperatorTransitionError> {
    match action {
        OperatorAction::Start => {
            if workflow.state != OperatorState::Planned {
                return Err(OperatorTransitionError::Conflict(
                    "only a planned workflow can start".into(),
                ));
            }
            workflow.state = OperatorState::Running;
            workflow.started_at_ms = Some(unix_time_ms());
            workflow.cancellation_requested = false;
            push_audit(
                workflow,
                "run_started",
                "Operator started the approved plan.",
            );
            Ok("Operator run started.".into())
        }
        OperatorAction::Cancel => {
            if workflow.state != OperatorState::Running {
                return Err(OperatorTransitionError::Conflict(
                    "only a running workflow can be cancelled".into(),
                ));
            }
            workflow.state = OperatorState::Cancelling;
            workflow.cancellation_requested = true;
            push_audit(
                workflow,
                "cancellation_requested",
                "No additional specialist tasks will be dispatched.",
            );
            Ok("Cancellation requested.".into())
        }
        OperatorAction::RetryFailed => {
            if !matches!(
                workflow.state,
                OperatorState::PartialFailure | OperatorState::Failed | OperatorState::Cancelled
            ) {
                return Err(OperatorTransitionError::Conflict(
                    "retry requires a failed, partially failed, or cancelled workflow".into(),
                ));
            }
            let mut reopened = 0;
            for step in &mut workflow.steps {
                if matches!(
                    step.status,
                    OperatorStepStatus::Failed
                        | OperatorStepStatus::Blocked
                        | OperatorStepStatus::Cancelled
                ) {
                    step.status = OperatorStepStatus::Pending;
                    step.task_id = None;
                    step.summary = None;
                    step.error = None;
                    reopened += 1;
                }
            }
            if reopened == 0 {
                return Err(OperatorTransitionError::InvalidAction(
                    "no failed, blocked, or cancelled steps are available to retry".into(),
                ));
            }
            workflow.state = OperatorState::Running;
            workflow.cancellation_requested = false;
            workflow.completed_at_ms = None;
            push_audit(
                workflow,
                "retry_started",
                &format!("Reopened {reopened} incomplete step(s)."),
            );
            Ok(format!("Retry started for {reopened} incomplete step(s)."))
        }
    }
}

impl OperatorWorkflow {
    #[must_use]
    pub fn runnable_steps(&self) -> Vec<usize> {
        let completed: HashSet<_> = self
            .steps
            .iter()
            .filter(|step| step.status == OperatorStepStatus::Completed)
            .map(|step| step.id.as_str())
            .collect();
        self.steps
            .iter()
            .enumerate()
            .filter_map(|(index, step)| {
                (step.status == OperatorStepStatus::Pending
                    && step
                        .depends_on
                        .iter()
                        .all(|dependency| completed.contains(dependency.as_str())))
                .then_some(index)
            })
            .collect()
    }

    #[must_use]
    pub fn next_runnable_step(&self) -> Option<usize> {
        self.runnable_steps().into_iter().next()
    }

    pub fn mark_running(&mut self, index: usize, task_id: Uuid) {
        let step = &mut self.steps[index];
        step.status = OperatorStepStatus::Running;
        step.task_id = Some(task_id);
        let detail = format!("{} assigned to {}.", step.title, step.bot);
        push_audit(self, "step_started", &detail);
    }

    pub fn mark_completed(&mut self, index: usize, summary: String) {
        let title = self.steps[index].title.clone();
        self.steps[index].status = OperatorStepStatus::Completed;
        self.steps[index].summary = Some(summary);
        self.steps[index].error = None;
        push_audit(self, "step_completed", &format!("{title} completed."));
    }

    pub fn mark_failed(&mut self, index: usize, error: String) {
        let title = self.steps[index].title.clone();
        self.steps[index].status = OperatorStepStatus::Failed;
        self.steps[index].error = Some(error);
        push_audit(self, "step_failed", &format!("{title} failed."));
    }

    pub fn finalize(&mut self) {
        if self.cancellation_requested || self.state == OperatorState::Cancelling {
            for step in &mut self.steps {
                if matches!(
                    step.status,
                    OperatorStepStatus::Pending | OperatorStepStatus::Running
                ) {
                    step.status = OperatorStepStatus::Cancelled;
                }
            }
            self.state = OperatorState::Cancelled;
            self.completed_at_ms = Some(unix_time_ms());
            push_audit(
                self,
                "run_cancelled",
                "Operator stopped dispatching new work.",
            );
            return;
        }

        let failed_ids: HashSet<_> = self
            .steps
            .iter()
            .filter(|step| {
                matches!(
                    step.status,
                    OperatorStepStatus::Failed | OperatorStepStatus::Blocked
                )
            })
            .map(|step| step.id.clone())
            .collect();
        let mut changed = true;
        while changed {
            changed = false;
            let blocked_ids: HashSet<_> = self
                .steps
                .iter()
                .filter(|step| step.status == OperatorStepStatus::Blocked)
                .map(|step| step.id.clone())
                .chain(failed_ids.iter().cloned())
                .collect();
            for step in &mut self.steps {
                if step.status == OperatorStepStatus::Pending
                    && step
                        .depends_on
                        .iter()
                        .any(|dependency| blocked_ids.contains(dependency))
                {
                    step.status = OperatorStepStatus::Blocked;
                    step.error = Some("A required dependency did not complete.".into());
                    changed = true;
                }
            }
        }

        let completed = self
            .steps
            .iter()
            .filter(|step| step.status == OperatorStepStatus::Completed)
            .count();
        let failed = self
            .steps
            .iter()
            .filter(|step| {
                matches!(
                    step.status,
                    OperatorStepStatus::Failed | OperatorStepStatus::Blocked
                )
            })
            .count();
        self.state = if failed == 0 && completed == self.steps.len() {
            OperatorState::Completed
        } else if completed > 0 {
            OperatorState::PartialFailure
        } else {
            OperatorState::Failed
        };
        self.completed_at_ms = Some(unix_time_ms());
        let state = format!("{:?}", self.state).to_ascii_lowercase();
        push_audit(
            self,
            "run_finished",
            &format!("Run finished as {state}: {completed} completed, {failed} incomplete."),
        );
    }
}

fn validate_input(input: &OperatorInput) -> Result<(), BotError> {
    if input.objective.trim().is_empty() || input.objective.len() > 2_000 {
        return Err(BotError::InvalidInput(
            "objective must contain between 1 and 2,000 characters".into(),
        ));
    }
    if input.steps.is_empty() || input.steps.len() > MAX_STEPS {
        return Err(BotError::InvalidInput(format!(
            "steps must contain between 1 and {MAX_STEPS} items"
        )));
    }
    let mut positions = HashMap::new();
    for (index, step) in input.steps.iter().enumerate() {
        if step.id.is_empty()
            || step.id.len() > 40
            || !step.id.chars().all(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
            })
        {
            return Err(BotError::InvalidInput(
                "step ids must use 1-40 lowercase letters, numbers, or hyphens".into(),
            ));
        }
        if positions.insert(step.id.as_str(), index).is_some() {
            return Err(BotError::InvalidInput(format!(
                "step id '{}' is duplicated",
                step.id
            )));
        }
        if step.title.trim().is_empty() || step.prompt.trim().is_empty() {
            return Err(BotError::InvalidInput(format!(
                "step '{}' requires a title and prompt",
                step.id
            )));
        }
        if !ALLOWED_BOTS.contains(&step.bot.as_str()) {
            return Err(BotError::InvalidInput(format!(
                "step '{}' uses unsupported bot '{}'",
                step.id, step.bot
            )));
        }
    }
    for (index, step) in input.steps.iter().enumerate() {
        let mut unique_dependencies = HashSet::new();
        for dependency in &step.depends_on {
            let Some(position) = positions.get(dependency.as_str()) else {
                return Err(BotError::InvalidInput(format!(
                    "step '{}' references unknown dependency '{dependency}'",
                    step.id
                )));
            };
            if *position >= index {
                return Err(BotError::InvalidInput(format!(
                    "step '{}' dependencies must appear earlier in the plan",
                    step.id
                )));
            }
            if !unique_dependencies.insert(dependency) {
                return Err(BotError::InvalidInput(format!(
                    "step '{}' repeats dependency '{dependency}'",
                    step.id
                )));
            }
        }
    }
    Ok(())
}

fn push_audit(workflow: &mut OperatorWorkflow, event: &str, detail: &str) {
    workflow.audit_history.push(OperatorAuditEvent {
        sequence: u32::try_from(workflow.audit_history.len() + 1).unwrap_or(u32::MAX),
        event: event.into(),
        detail: detail.into(),
        at_ms: unix_time_ms(),
    });
}

fn unix_time_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use donads_core::{Bot, Task, TaskInput};
    use serde_json::json;

    use super::{
        Operator, OperatorAction, OperatorState, OperatorStepStatus, OperatorWorkflow, apply_action,
    };

    fn task() -> Task {
        Task::queued(
            TaskInput {
                prompt: "Launch a researched campaign".into(),
                bot: Some("operator".into()),
                input: json!({
                    "objective": "Launch a researched campaign",
                    "target_date": "2026-12-01",
                    "steps": [
                        {"id":"research","title":"Research","bot":"scout","prompt":"Research sources","input":{"sources":["https://example.com"]},"depends_on":[]},
                        {"id":"campaign","title":"Campaign","bot":"growth","prompt":"Create drafts","input":{},"depends_on":["research"]}
                    ]
                }),
            },
            "operator".into(),
        )
    }

    async fn workflow() -> OperatorWorkflow {
        let result = Operator.execute(&task()).await.expect("plan should build");
        serde_json::from_value(result.data["workflow"].clone())
            .expect("workflow should deserialize")
    }

    #[tokio::test]
    async fn builds_dependency_ordered_plan() {
        let mut workflow = workflow().await;
        assert_eq!(workflow.next_runnable_step(), Some(0));
        apply_action(&mut workflow, OperatorAction::Start).expect("plan should start");
        workflow.mark_running(0, uuid::Uuid::new_v4());
        workflow.mark_completed(0, "done".into());
        assert_eq!(workflow.next_runnable_step(), Some(1));
    }

    #[tokio::test]
    async fn blocks_dependents_and_retries_only_incomplete_steps() {
        let mut workflow = workflow().await;
        apply_action(&mut workflow, OperatorAction::Start).expect("plan should start");
        workflow.mark_failed(0, "source failed".into());
        workflow.finalize();
        assert_eq!(workflow.state, OperatorState::Failed);
        assert_eq!(workflow.steps[1].status, OperatorStepStatus::Blocked);
        apply_action(&mut workflow, OperatorAction::RetryFailed).expect("retry should start");
        assert!(
            workflow
                .steps
                .iter()
                .all(|step| step.status == OperatorStepStatus::Pending)
        );
    }

    #[tokio::test]
    async fn cancellation_marks_remaining_steps_without_permissions() {
        let mut workflow = workflow().await;
        apply_action(&mut workflow, OperatorAction::Start).expect("plan should start");
        apply_action(&mut workflow, OperatorAction::Cancel).expect("run should cancel");
        workflow.finalize();
        assert_eq!(workflow.state, OperatorState::Cancelled);
        assert!(!workflow.permissions.external_writes);
        assert!(!workflow.permissions.signing_available);
        assert!(
            workflow
                .steps
                .iter()
                .all(|step| step.status == OperatorStepStatus::Cancelled)
        );
    }

    #[tokio::test]
    async fn rejects_forward_dependencies() {
        let mut invalid = task();
        invalid.input["steps"][0]["depends_on"] = json!(["campaign"]);
        assert!(Operator.execute(&invalid).await.is_err());
    }

    #[tokio::test]
    async fn exposes_independent_steps_as_one_parallel_wave() {
        let mut parallel = task();
        parallel.input["steps"] = json!([
            {"id":"research-a","title":"Research A","bot":"scout","prompt":"Research A","input":{"sources":["https://example.com/a"]},"depends_on":[]},
            {"id":"research-b","title":"Research B","bot":"scout","prompt":"Research B","input":{"sources":["https://example.com/b"]},"depends_on":[]},
            {"id":"campaign","title":"Campaign","bot":"growth","prompt":"Create drafts","input":{},"depends_on":["research-a","research-b"]}
        ]);
        let result = Operator.execute(&parallel).await.expect("parallel plan");
        let mut workflow: OperatorWorkflow =
            serde_json::from_value(result.data["workflow"].clone()).expect("workflow");
        assert_eq!(workflow.runnable_steps(), vec![0, 1]);
        workflow.mark_running(0, uuid::Uuid::new_v4());
        workflow.mark_running(1, uuid::Uuid::new_v4());
        assert!(workflow.runnable_steps().is_empty());
        workflow.mark_completed(0, "a".into());
        assert!(workflow.runnable_steps().is_empty());
        workflow.mark_completed(1, "b".into());
        assert_eq!(workflow.runnable_steps(), vec![2]);
    }
}
