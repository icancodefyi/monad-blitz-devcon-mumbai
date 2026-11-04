mod auth;

use std::{collections::HashMap, env, net::SocketAddr, path::PathBuf, sync::Arc, time::Instant};

use anyhow::{Context, anyhow};
use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{
        HeaderValue, Method, Request, StatusCode,
        header::{AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use bot_commerce::{
    Commerce, CommerceState, CommerceTransitionError, CommerceWorkflow, authorize, reject,
};
use bot_flow::{
    Flow, FlowTransitionError, PaymentWorkflow, WorkflowAction, apply_action, confirm_execution,
    mon_amount_to_wei,
};
use bot_growth::{BrandProfile, Growth};
use bot_operator::{
    Operator, OperatorAction, OperatorInput, OperatorState, OperatorStep, OperatorStepInput,
    OperatorStepStatus, OperatorTransitionError, OperatorWorkflow,
    apply_action as apply_operator_action,
};
use bot_scout::Scout;
use bot_sentinel::{NativeTransferPolicyRequest, Sentinel, SentinelPolicyGuard};
use donads_core::{
    Bot, BotDescriptor, ChainClient, Network, Task, TaskEvent, TaskFeedback, TaskInput, TaskStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;
use tokio::sync::{Mutex, RwLock};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::{error, info, warn};
use uuid::Uuid;

use auth::{
    AuthPrincipal, AuthService, ChallengeInput, ChallengeOutput, SessionOutput, VerifyInput,
};

type BotMap = HashMap<String, Arc<dyn Bot>>;

#[derive(Clone)]
struct PersistentTaskStore {
    tasks: Arc<RwLock<HashMap<Uuid, Task>>>,
    path: Arc<PathBuf>,
    save_lock: Arc<Mutex<()>>,
}

#[derive(Clone)]
struct PersistentProfileStore {
    profiles: Arc<RwLock<HashMap<String, OwnedProfileRecord>>>,
    path: Arc<PathBuf>,
    save_lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct OwnedProfileRecord {
    owner_id: String,
    profile: BrandProfile,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct OperatorRoutine {
    id: String,
    name: String,
    description: String,
    version: u32,
    created_at_ms: u64,
    updated_at_ms: u64,
    input: OperatorInput,
}

#[derive(Clone)]
struct PersistentRoutineStore {
    routines: Arc<RwLock<HashMap<String, OwnedRoutineRecord>>>,
    path: Arc<PathBuf>,
    save_lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct OwnedRoutineRecord {
    owner_id: String,
    routine: OperatorRoutine,
}

impl PersistentRoutineStore {
    async fn load(path: PathBuf) -> anyhow::Result<Self> {
        let routines = match tokio::fs::read(&path).await {
            Ok(bytes) => {
                let records = serde_json::from_slice::<Vec<OwnedRoutineRecord>>(&bytes)
                    .or_else(|_| {
                        serde_json::from_slice::<Vec<OperatorRoutine>>(&bytes).map(|legacy| {
                            legacy
                                .into_iter()
                                .map(|routine| OwnedRoutineRecord {
                                    owner_id: "legacy-local".into(),
                                    routine,
                                })
                                .collect()
                        })
                    })
                    .with_context(|| {
                        format!("could not parse routine store at {}", path.display())
                    })?;
                records
                    .into_iter()
                    .map(|record| (owned_key(&record.owner_id, &record.routine.id), record))
                    .collect()
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => {
                return Err(error).with_context(|| format!("could not read {}", path.display()));
            }
        };
        Ok(Self {
            routines: Arc::new(RwLock::new(routines)),
            path: Arc::new(path),
            save_lock: Arc::new(Mutex::new(())),
        })
    }

    async fn list(&self, owner_id: &str) -> Vec<OperatorRoutine> {
        let mut routines: Vec<_> = self
            .routines
            .read()
            .await
            .values()
            .filter(|record| record.owner_id == owner_id)
            .map(|record| record.routine.clone())
            .collect();
        routines.sort_by(|left, right| left.name.cmp(&right.name));
        routines
    }

    async fn get(&self, owner_id: &str, id: &str) -> Option<OperatorRoutine> {
        self.routines
            .read()
            .await
            .get(&owned_key(owner_id, id))
            .map(|record| record.routine.clone())
    }

    async fn save(
        &self,
        owner_id: &str,
        mut routine: OperatorRoutine,
    ) -> anyhow::Result<OperatorRoutine> {
        let mut routines = self.routines.write().await;
        let key = owned_key(owner_id, &routine.id);
        if let Some(existing) = routines.get(&key) {
            routine.version = existing.routine.version.saturating_add(1);
            routine.created_at_ms = existing.routine.created_at_ms;
        }
        routine.updated_at_ms = unix_time_ms();
        routines.insert(
            key,
            OwnedRoutineRecord {
                owner_id: owner_id.into(),
                routine: routine.clone(),
            },
        );
        drop(routines);
        self.persist().await?;
        Ok(routine)
    }

    async fn persist(&self) -> anyhow::Result<()> {
        let _save_guard = self.save_lock.lock().await;
        let mut snapshot: Vec<_> = self.routines.read().await.values().cloned().collect();
        snapshot.sort_by(|left, right| {
            left.owner_id
                .cmp(&right.owner_id)
                .then_with(|| left.routine.id.cmp(&right.routine.id))
        });
        persist_json(self.path.as_ref(), &snapshot).await
    }
}

impl PersistentProfileStore {
    async fn load(path: PathBuf) -> anyhow::Result<Self> {
        let profiles = match tokio::fs::read(&path).await {
            Ok(bytes) => {
                let records = serde_json::from_slice::<Vec<OwnedProfileRecord>>(&bytes)
                    .or_else(|_| {
                        serde_json::from_slice::<Vec<BrandProfile>>(&bytes).map(|legacy| {
                            legacy
                                .into_iter()
                                .map(|profile| OwnedProfileRecord {
                                    owner_id: "legacy-local".into(),
                                    profile,
                                })
                                .collect()
                        })
                    })
                    .with_context(|| {
                        format!("could not parse profile store at {}", path.display())
                    })?;
                records
                    .into_iter()
                    .map(|record| (owned_key(&record.owner_id, &record.profile.id), record))
                    .collect()
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => {
                return Err(error).with_context(|| format!("could not read {}", path.display()));
            }
        };
        Ok(Self {
            profiles: Arc::new(RwLock::new(profiles)),
            path: Arc::new(path),
            save_lock: Arc::new(Mutex::new(())),
        })
    }

    async fn list(&self, owner_id: &str) -> Vec<BrandProfile> {
        let mut profiles: Vec<_> = self
            .profiles
            .read()
            .await
            .values()
            .filter(|record| record.owner_id == owner_id)
            .map(|record| record.profile.clone())
            .collect();
        profiles.sort_by(|left, right| left.project_name.cmp(&right.project_name));
        profiles
    }

    async fn get(&self, owner_id: &str, id: &str) -> Option<BrandProfile> {
        self.profiles
            .read()
            .await
            .get(&owned_key(owner_id, id))
            .map(|record| record.profile.clone())
    }

    async fn save(
        &self,
        owner_id: &str,
        mut profile: BrandProfile,
    ) -> anyhow::Result<BrandProfile> {
        let mut profiles = self.profiles.write().await;
        let key = owned_key(owner_id, &profile.id);
        profile.version = profiles
            .get(&key)
            .map_or(1, |existing| existing.profile.version.saturating_add(1));
        profile.updated_at_ms = unix_time_ms();
        profiles.insert(
            key,
            OwnedProfileRecord {
                owner_id: owner_id.into(),
                profile: profile.clone(),
            },
        );
        drop(profiles);
        self.persist().await?;
        Ok(profile)
    }

    async fn persist(&self) -> anyhow::Result<()> {
        let _save_guard = self.save_lock.lock().await;
        let mut snapshot: Vec<_> = self.profiles.read().await.values().cloned().collect();
        snapshot.sort_by(|left, right| {
            left.owner_id
                .cmp(&right.owner_id)
                .then_with(|| left.profile.id.cmp(&right.profile.id))
        });
        persist_json(self.path.as_ref(), &snapshot).await
    }
}

impl PersistentTaskStore {
    async fn load(path: PathBuf) -> anyhow::Result<Self> {
        let tasks = match tokio::fs::read(&path).await {
            Ok(bytes) => serde_json::from_slice::<Vec<Task>>(&bytes)
                .with_context(|| format!("could not parse task store at {}", path.display()))?
                .into_iter()
                .map(|task| (task.id, task))
                .collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => {
                return Err(error).with_context(|| format!("could not read {}", path.display()));
            }
        };
        let store = Self {
            tasks: Arc::new(RwLock::new(tasks)),
            path: Arc::new(path),
            save_lock: Arc::new(Mutex::new(())),
        };
        if store.recover_interrupted().await {
            store.persist().await?;
        }
        Ok(store)
    }

    async fn insert(&self, task: Task) -> anyhow::Result<()> {
        self.tasks.write().await.insert(task.id, task);
        self.persist().await
    }

    async fn get(&self, id: Uuid) -> Option<Task> {
        self.tasks.read().await.get(&id).cloned()
    }

    async fn list(&self, owner_id: &str, limit: usize) -> Vec<Task> {
        let mut tasks: Vec<_> = self
            .tasks
            .read()
            .await
            .values()
            .filter(|task| task.owner_id == owner_id)
            .cloned()
            .collect();
        tasks.sort_by_key(|task| std::cmp::Reverse(task.created_at_ms));
        tasks.truncate(limit);
        tasks
    }

    async fn transition(
        &self,
        id: Uuid,
        status: TaskStatus,
        kind: &str,
        message: impl Into<String>,
    ) -> anyhow::Result<()> {
        let mut tasks = self.tasks.write().await;
        tasks
            .get_mut(&id)
            .ok_or_else(|| anyhow!("task {id} disappeared"))?
            .transition(status, kind, message);
        drop(tasks);
        self.persist().await
    }

    async fn record_feedback(&self, id: Uuid, feedback: TaskFeedback) -> anyhow::Result<Task> {
        let mut tasks = self.tasks.write().await;
        let task = tasks
            .get_mut(&id)
            .ok_or_else(|| anyhow!("task {id} disappeared"))?;
        task.record_feedback(feedback);
        let updated = task.clone();
        drop(tasks);
        self.persist().await?;
        Ok(updated)
    }

    async fn apply_flow_action(
        &self,
        id: Uuid,
        action: WorkflowAction,
    ) -> Result<FlowActionResponse, FlowMutationError> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(&id).ok_or(FlowMutationError::NotFound)?;
        if task.bot != "flow" {
            return Err(FlowMutationError::InvalidTask(
                "workflow actions require a Flow task".into(),
            ));
        }
        let (summary, data, latency_ms) = match &task.status {
            TaskStatus::Completed {
                summary,
                data,
                latency_ms,
            } => (summary.clone(), data.clone(), *latency_ms),
            _ => {
                return Err(FlowMutationError::InvalidTask(
                    "workflow actions require a completed Flow task".into(),
                ));
            }
        };
        let workflow: PaymentWorkflow = serde_json::from_value(data["workflow"].clone())
            .map_err(FlowMutationError::CorruptWorkflow)?;
        let outcome = apply_action(workflow, action)?;
        let mut updated_data = data;
        updated_data["workflow"] =
            serde_json::to_value(&outcome.workflow).map_err(FlowMutationError::CorruptWorkflow)?;
        let message = outcome.message.clone();
        task.transition(
            TaskStatus::Completed {
                summary,
                data: updated_data,
                latency_ms,
            },
            "workflow_action",
            message,
        );
        let response = FlowActionResponse {
            task: task.clone(),
            duplicate_prevented: outcome.duplicate_prevented,
        };
        drop(tasks);
        self.persist()
            .await
            .map_err(FlowMutationError::Persistence)?;
        Ok(response)
    }

    async fn flow_workflow(&self, id: Uuid) -> Result<PaymentWorkflow, FlowMutationError> {
        let tasks = self.tasks.read().await;
        let task = tasks.get(&id).ok_or(FlowMutationError::NotFound)?;
        flow_task_parts(task).map(|(_, _, _, workflow)| workflow)
    }

    async fn save_flow_workflow(
        &self,
        id: Uuid,
        workflow: PaymentWorkflow,
        message: impl Into<String>,
    ) -> Result<Task, FlowMutationError> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(&id).ok_or(FlowMutationError::NotFound)?;
        let (summary, mut data, latency_ms, _) = flow_task_parts(task)?;
        data["workflow"] =
            serde_json::to_value(workflow).map_err(FlowMutationError::CorruptWorkflow)?;
        task.transition(
            TaskStatus::Completed {
                summary,
                data,
                latency_ms,
            },
            "transaction_confirmed",
            message,
        );
        let updated = task.clone();
        drop(tasks);
        self.persist()
            .await
            .map_err(FlowMutationError::Persistence)?;
        Ok(updated)
    }

    async fn commerce_workflow(&self, id: Uuid) -> Result<CommerceWorkflow, CommerceMutationError> {
        let tasks = self.tasks.read().await;
        let task = tasks.get(&id).ok_or(CommerceMutationError::NotFound)?;
        commerce_task_parts(task).map(|(_, _, _, workflow)| workflow)
    }

    async fn save_commerce_workflow(
        &self,
        id: Uuid,
        expected_state: CommerceState,
        workflow: CommerceWorkflow,
        message: impl Into<String>,
    ) -> Result<Task, CommerceMutationError> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(&id).ok_or(CommerceMutationError::NotFound)?;
        let (summary, mut data, latency_ms, current) = commerce_task_parts(task)?;
        if current.state != expected_state {
            return Err(CommerceMutationError::Transition(
                CommerceTransitionError::Conflict(format!(
                    "expected {expected_state:?}, found {:?}",
                    current.state
                )),
            ));
        }
        data["workflow"] =
            serde_json::to_value(workflow).map_err(CommerceMutationError::CorruptWorkflow)?;
        task.transition(
            TaskStatus::Completed {
                summary,
                data,
                latency_ms,
            },
            "commerce_action",
            message,
        );
        let updated = task.clone();
        drop(tasks);
        self.persist()
            .await
            .map_err(CommerceMutationError::Persistence)?;
        Ok(updated)
    }

    async fn apply_operator_action(
        &self,
        id: Uuid,
        action: OperatorAction,
    ) -> Result<Task, OperatorMutationError> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(&id).ok_or(OperatorMutationError::NotFound)?;
        let (summary, mut data, latency_ms, mut workflow) = operator_task_parts(task)?;
        let message = apply_operator_action(&mut workflow, action)?;
        data["workflow"] =
            serde_json::to_value(workflow).map_err(OperatorMutationError::CorruptWorkflow)?;
        task.transition(
            TaskStatus::Completed {
                summary,
                data,
                latency_ms,
            },
            "operator_action",
            message,
        );
        let updated = task.clone();
        drop(tasks);
        self.persist()
            .await
            .map_err(OperatorMutationError::Persistence)?;
        Ok(updated)
    }

    async fn operator_workflow(&self, id: Uuid) -> Result<OperatorWorkflow, OperatorMutationError> {
        let tasks = self.tasks.read().await;
        let task = tasks.get(&id).ok_or(OperatorMutationError::NotFound)?;
        operator_task_parts(task).map(|(_, _, _, workflow)| workflow)
    }

    async fn mark_operator_step_running(
        &self,
        id: Uuid,
        step_index: usize,
        child_id: Uuid,
    ) -> Result<bool, OperatorMutationError> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(&id).ok_or(OperatorMutationError::NotFound)?;
        let (summary, mut data, latency_ms, mut workflow) = operator_task_parts(task)?;
        if workflow.state != OperatorState::Running || workflow.cancellation_requested {
            return Ok(false);
        }
        if step_index >= workflow.steps.len() {
            return Err(OperatorMutationError::InvalidTask(
                "Operator step index is invalid".into(),
            ));
        }
        workflow.mark_running(step_index, child_id);
        data["workflow"] =
            serde_json::to_value(workflow).map_err(OperatorMutationError::CorruptWorkflow)?;
        task.transition(
            TaskStatus::Completed {
                summary,
                data,
                latency_ms,
            },
            "operator_progress",
            "Operator dispatched the next specialist step.",
        );
        drop(tasks);
        self.persist()
            .await
            .map_err(OperatorMutationError::Persistence)?;
        Ok(true)
    }

    async fn mark_operator_step_result(
        &self,
        id: Uuid,
        step_index: usize,
        result: Result<String, String>,
    ) -> Result<(), OperatorMutationError> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(&id).ok_or(OperatorMutationError::NotFound)?;
        let (summary, mut data, latency_ms, mut workflow) = operator_task_parts(task)?;
        if step_index >= workflow.steps.len() {
            return Err(OperatorMutationError::InvalidTask(
                "Operator step index is invalid".into(),
            ));
        }
        match result {
            Ok(step_summary) => workflow.mark_completed(step_index, step_summary),
            Err(step_error) => workflow.mark_failed(step_index, step_error),
        }
        data["workflow"] =
            serde_json::to_value(workflow).map_err(OperatorMutationError::CorruptWorkflow)?;
        task.transition(
            TaskStatus::Completed {
                summary,
                data,
                latency_ms,
            },
            "operator_progress",
            "Operator recorded a specialist result.",
        );
        drop(tasks);
        self.persist()
            .await
            .map_err(OperatorMutationError::Persistence)
    }

    async fn finalize_operator(&self, id: Uuid) -> Result<Task, OperatorMutationError> {
        let mut tasks = self.tasks.write().await;
        let task = tasks.get_mut(&id).ok_or(OperatorMutationError::NotFound)?;
        let (summary, mut data, latency_ms, mut workflow) = operator_task_parts(task)?;
        workflow.finalize();
        let final_state = format!("{:?}", workflow.state).to_ascii_lowercase();
        data["workflow"] =
            serde_json::to_value(workflow).map_err(OperatorMutationError::CorruptWorkflow)?;
        task.transition(
            TaskStatus::Completed {
                summary,
                data,
                latency_ms,
            },
            "operator_finished",
            format!("Operator run finished as {final_state}."),
        );
        let updated = task.clone();
        drop(tasks);
        self.persist()
            .await
            .map_err(OperatorMutationError::Persistence)?;
        Ok(updated)
    }

    async fn recover_interrupted(&self) -> bool {
        let mut changed = false;
        for task in self.tasks.write().await.values_mut() {
            if matches!(task.status, TaskStatus::Queued | TaskStatus::Running) {
                task.transition(
                    TaskStatus::Failed {
                        error: "Dispatcher restarted before this task finished. Submit it again."
                            .into(),
                        latency_ms: 0,
                    },
                    "recovered",
                    "Interrupted task recovered after restart.",
                );
                changed = true;
                continue;
            }
            if task.bot == "operator" {
                let TaskStatus::Completed {
                    summary,
                    data,
                    latency_ms,
                } = &task.status
                else {
                    continue;
                };
                let Ok(mut workflow) =
                    serde_json::from_value::<OperatorWorkflow>(data["workflow"].clone())
                else {
                    continue;
                };
                if !matches!(
                    workflow.state,
                    OperatorState::Running | OperatorState::Cancelling
                ) {
                    continue;
                }
                if workflow.state == OperatorState::Running {
                    for step in &mut workflow.steps {
                        match step.status {
                            OperatorStepStatus::Running => {
                                step.status = OperatorStepStatus::Failed;
                                step.error = Some(
                                    "Dispatcher restarted while this specialist was running."
                                        .into(),
                                );
                            }
                            OperatorStepStatus::Pending => {
                                step.status = OperatorStepStatus::Blocked;
                                step.error = Some(
                                    "Dispatcher restarted before this step was dispatched.".into(),
                                );
                            }
                            _ => {}
                        }
                    }
                }
                workflow.finalize();
                let mut recovered_data = data.clone();
                recovered_data["workflow"] = serde_json::to_value(workflow)
                    .expect("Operator workflow serialization cannot fail");
                task.transition(
                    TaskStatus::Completed {
                        summary: summary.clone(),
                        data: recovered_data,
                        latency_ms: *latency_ms,
                    },
                    "recovered",
                    "Interrupted Operator run recovered after restart.",
                );
                changed = true;
            }
        }
        changed
    }

    async fn persist(&self) -> anyhow::Result<()> {
        let _save_guard = self.save_lock.lock().await;
        let mut snapshot: Vec<_> = self.tasks.read().await.values().cloned().collect();
        snapshot.sort_by_key(|task| task.created_at_ms);
        persist_json(self.path.as_ref(), &snapshot).await
    }
}

async fn persist_json<T: Serialize>(path: &PathBuf, value: &T) -> anyhow::Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    tokio::fs::write(&temporary, bytes).await?;
    if tokio::fs::try_exists(path).await? {
        if tokio::fs::try_exists(&backup).await? {
            tokio::fs::remove_file(&backup).await?;
        }
        tokio::fs::rename(path, &backup).await?;
    }
    if let Err(rename_error) = tokio::fs::rename(&temporary, path).await {
        if tokio::fs::try_exists(&backup).await.unwrap_or(false) {
            let _ = tokio::fs::rename(&backup, path).await;
        }
        return Err(rename_error.into());
    }
    if tokio::fs::try_exists(&backup).await? {
        tokio::fs::remove_file(backup).await?;
    }
    Ok(())
}

fn owned_key(owner_id: &str, record_id: &str) -> String {
    format!("{owner_id}\0{record_id}")
}

#[derive(Clone)]
struct AppState {
    bots: Arc<BotMap>,
    tasks: PersistentTaskStore,
    profiles: PersistentProfileStore,
    routines: PersistentRoutineStore,
    chain: ChainClient,
    auth: AuthService,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    chain: serde_json::Value,
    persistence: &'static str,
    commerce: serde_json::Value,
}

#[derive(Deserialize)]
struct FeedbackInput {
    rating: u8,
    note: Option<String>,
}

#[derive(Deserialize)]
struct TaskHistoryQuery {
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct RoutineCaptureInput {
    id: String,
    name: String,
    #[serde(default)]
    description: String,
}

#[derive(Serialize)]
struct FlowActionResponse {
    task: Task,
    duplicate_prevented: bool,
}

#[derive(Deserialize)]
struct FlowTransactionInput {
    transaction_hash: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum CommerceAction {
    Approve { approved_total_atomic: String },
    Reject,
}

fn operator_task_parts(
    task: &Task,
) -> Result<(String, serde_json::Value, u64, OperatorWorkflow), OperatorMutationError> {
    if task.bot != "operator" {
        return Err(OperatorMutationError::InvalidTask(
            "orchestration actions require an Operator task".into(),
        ));
    }
    let (summary, data, latency_ms) = match &task.status {
        TaskStatus::Completed {
            summary,
            data,
            latency_ms,
        } => (summary.clone(), data.clone(), *latency_ms),
        _ => {
            return Err(OperatorMutationError::InvalidTask(
                "orchestration actions require a completed Operator plan".into(),
            ));
        }
    };
    let workflow = serde_json::from_value(data["workflow"].clone())
        .map_err(OperatorMutationError::CorruptWorkflow)?;
    Ok((summary, data, latency_ms, workflow))
}

fn flow_task_parts(
    task: &Task,
) -> Result<(String, serde_json::Value, u64, PaymentWorkflow), FlowMutationError> {
    if task.bot != "flow" {
        return Err(FlowMutationError::InvalidTask(
            "workflow actions require a Flow task".into(),
        ));
    }
    let (summary, data, latency_ms) = match &task.status {
        TaskStatus::Completed {
            summary,
            data,
            latency_ms,
        } => (summary.clone(), data.clone(), *latency_ms),
        _ => {
            return Err(FlowMutationError::InvalidTask(
                "workflow actions require a completed Flow task".into(),
            ));
        }
    };
    let workflow = serde_json::from_value(data["workflow"].clone())
        .map_err(FlowMutationError::CorruptWorkflow)?;
    Ok((summary, data, latency_ms, workflow))
}

fn commerce_task_parts(
    task: &Task,
) -> Result<(String, serde_json::Value, u64, CommerceWorkflow), CommerceMutationError> {
    if task.bot != "commerce" {
        return Err(CommerceMutationError::InvalidTask(
            "commerce actions require a Commerce task".into(),
        ));
    }
    let (summary, data, latency_ms) = match &task.status {
        TaskStatus::Completed {
            summary,
            data,
            latency_ms,
        } => (summary.clone(), data.clone(), *latency_ms),
        _ => {
            return Err(CommerceMutationError::InvalidTask(
                "commerce actions require a completed offer selection".into(),
            ));
        }
    };
    let workflow = serde_json::from_value(data["workflow"].clone())
        .map_err(CommerceMutationError::CorruptWorkflow)?;
    Ok((summary, data, latency_ms, workflow))
}

#[derive(Debug, Error)]
enum FlowMutationError {
    #[error("Flow task not found")]
    NotFound,
    #[error("{0}")]
    InvalidTask(String),
    #[error("stored Flow workflow is invalid: {0}")]
    CorruptWorkflow(serde_json::Error),
    #[error(transparent)]
    Transition(#[from] FlowTransitionError),
    #[error("could not persist Flow workflow: {0}")]
    Persistence(anyhow::Error),
}

#[derive(Debug, Error)]
enum OperatorMutationError {
    #[error("Operator task not found")]
    NotFound,
    #[error("{0}")]
    InvalidTask(String),
    #[error("stored Operator workflow is invalid: {0}")]
    CorruptWorkflow(serde_json::Error),
    #[error(transparent)]
    Transition(#[from] OperatorTransitionError),
    #[error("could not persist Operator workflow: {0}")]
    Persistence(anyhow::Error),
}

#[derive(Debug, Error)]
enum CommerceMutationError {
    #[error("Commerce task not found")]
    NotFound,
    #[error("{0}")]
    InvalidTask(String),
    #[error("stored Commerce workflow is invalid: {0}")]
    CorruptWorkflow(serde_json::Error),
    #[error(transparent)]
    Transition(#[from] CommerceTransitionError),
    #[error("could not persist Commerce workflow: {0}")]
    Persistence(anyhow::Error),
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "donads_dispatch=info,tower_http=info".into()),
        )
        .init();

    let network = match env::var("DONADS_NETWORK").as_deref() {
        Ok("mainnet") => Network::Mainnet,
        _ => Network::Testnet,
    };
    let default_rpc = match network {
        Network::Testnet => "https://testnet-rpc.monad.xyz",
        Network::Mainnet => "https://rpc.monad.xyz",
    };
    let rpc_url = env::var("MONAD_RPC_URL").unwrap_or_else(|_| default_rpc.into());
    let chain = ChainClient::new(rpc_url, network).context("failed to create Monad client")?;
    let auth = AuthService::new(
        env::var("DONADS_AUTH_DOMAIN").unwrap_or_else(|_| "localhost:3000".into()),
        env::var("DONADS_AUTH_URI").unwrap_or_else(|_| "http://localhost:3000".into()),
        network.chain_id(),
        env::var("DONADS_SESSION_REQUESTS_PER_MINUTE")
            .unwrap_or_else(|_| "120".into())
            .parse()
            .context("DONADS_SESSION_REQUESTS_PER_MINUTE must be a positive integer")?,
    )
    .map_err(|error| anyhow!(error.to_string()))?;

    let scout: Arc<dyn Bot> = Arc::new(Scout::new().context("failed to create Scout HTTP client")?);
    let commerce: Arc<dyn Bot> = Arc::new(Commerce);
    let flow: Arc<dyn Bot> = Arc::new(Flow);
    let growth: Arc<dyn Bot> = Arc::new(Growth);
    let operator: Arc<dyn Bot> = Arc::new(Operator);
    let sentinel: Arc<dyn Bot> = Arc::new(Sentinel);
    let bots = HashMap::from([
        (commerce.descriptor().id.to_owned(), commerce),
        (flow.descriptor().id.to_owned(), flow),
        (growth.descriptor().id.to_owned(), growth),
        (operator.descriptor().id.to_owned(), operator),
        (scout.descriptor().id.to_owned(), scout),
        (sentinel.descriptor().id.to_owned(), sentinel),
    ]);
    let data_path = env::var("DONADS_TASK_STORE")
        .map_or_else(|_| PathBuf::from("data/tasks.json"), PathBuf::from);
    let tasks = PersistentTaskStore::load(data_path).await?;
    let profile_path = env::var("DONADS_PROFILE_STORE")
        .map_or_else(|_| PathBuf::from("data/profiles.json"), PathBuf::from);
    let profiles = PersistentProfileStore::load(profile_path).await?;
    let routine_path = env::var("DONADS_ROUTINE_STORE")
        .map_or_else(|_| PathBuf::from("data/routines.json"), PathBuf::from);
    let routines = PersistentRoutineStore::load(routine_path).await?;
    let state = AppState {
        bots: Arc::new(bots),
        tasks,
        profiles,
        routines,
        chain,
        auth: auth.clone(),
    };
    let protected = Router::new()
        .route("/v1/tasks", get(list_tasks).post(create_task))
        .route("/v1/auth/logout", post(auth_logout))
        .route("/v1/tasks/{id}", get(get_task))
        .route("/v1/tasks/{id}/events", get(get_task_events))
        .route("/v1/tasks/{id}/feedback", post(record_feedback))
        .route("/v1/tasks/{id}/flow-actions", post(flow_action))
        .route(
            "/v1/tasks/{id}/flow-transaction",
            post(confirm_flow_transaction),
        )
        .route("/v1/tasks/{id}/commerce-actions", post(commerce_action))
        .route("/v1/tasks/{id}/operator-actions", post(operator_action))
        .route("/v1/tasks/{id}/routine", post(capture_routine))
        .route("/v1/routines", get(list_routines))
        .route("/v1/routines/{id}/runs", post(run_routine))
        .route("/v1/brand-profiles", get(list_profiles))
        .route(
            "/v1/brand-profiles/{id}",
            get(get_profile).put(save_profile),
        )
        .route_layer(middleware::from_fn_with_state(auth, auth::require_auth));
    let app = Router::new()
        .route("/v1/health", get(health))
        .route("/v1/bots", get(list_bots))
        .route("/v1/auth/challenge", post(auth_challenge))
        .route("/v1/auth/verify", post(auth_verify))
        .merge(protected)
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn(security_headers))
        .layer(cors_layer()?)
        .with_state(state);

    let address: SocketAddr = env::var("DONADS_BIND_ADDRESS")
        .unwrap_or_else(|_| {
            env::var("PORT")
                .map(|port| format!("0.0.0.0:{port}"))
                .unwrap_or_else(|_| "127.0.0.1:8080".into())
        })
        .parse()
        .context("DONADS_BIND_ADDRESS or PORT must form a valid socket address")?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    info!(%address, "DONADS dispatch listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let commerce = json!({
        "mode": "crypto_only",
        "execution": "blocked_until_wallet_and_crypto_merchant_adapter"
    });
    match state.chain.status().await {
        Ok(status) => (
            StatusCode::OK,
            Json(HealthResponse {
                status: "ok",
                service: "donads-dispatch",
                chain: serde_json::to_value(status)
                    .unwrap_or_else(|_| json!({"status": "unknown"})),
                persistence: "ready",
                commerce: commerce.clone(),
            }),
        ),
        Err(error) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthResponse {
                status: "degraded",
                service: "donads-dispatch",
                chain: json!({"error": error.to_string()}),
                persistence: "ready",
                commerce,
            }),
        ),
    }
}

async fn list_bots(State(state): State<AppState>) -> Json<Vec<BotDescriptor>> {
    let mut bots: Vec<_> = state.bots.values().map(|bot| bot.descriptor()).collect();
    bots.sort_by_key(|bot| bot.id);
    Json(bots)
}

async fn auth_challenge(
    State(state): State<AppState>,
    Json(input): Json<ChallengeInput>,
) -> Result<Json<ChallengeOutput>, impl IntoResponse> {
    state.auth.create_challenge(&input.address).await.map(Json)
}

async fn auth_verify(
    State(state): State<AppState>,
    Json(input): Json<VerifyInput>,
) -> Result<Json<SessionOutput>, impl IntoResponse> {
    state.auth.verify(input).await.map(Json)
}

async fn auth_logout(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
) -> StatusCode {
    state.auth.revoke(&principal.session_token).await;
    StatusCode::NO_CONTENT
}

fn cors_layer() -> anyhow::Result<CorsLayer> {
    let configured = env::var("DONADS_ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:3000,http://127.0.0.1:3000".into());
    let origins: Vec<HeaderValue> = configured
        .split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .map(|origin| {
            origin
                .parse()
                .with_context(|| format!("invalid CORS origin: {origin}"))
        })
        .collect::<anyhow::Result<_>>()?;
    if origins.is_empty() {
        return Err(anyhow!(
            "DONADS_ALLOWED_ORIGINS must contain at least one origin"
        ));
    }
    Ok(CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([Method::GET, Method::POST, Method::PUT])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE]))
}

async fn security_headers(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'; base-uri 'none'"),
    );
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    response
}

async fn create_task(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
    Json(input): Json<TaskInput>,
) -> Result<(StatusCode, Json<Task>), ApiError> {
    enqueue_task(state, input, principal.owner_id).await
}

async fn list_tasks(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
    Query(query): Query<TaskHistoryQuery>,
) -> Json<Vec<Task>> {
    Json(
        state
            .tasks
            .list(&principal.owner_id, query.limit.unwrap_or(50).clamp(1, 100))
            .await,
    )
}

async fn enqueue_task(
    state: AppState,
    input: TaskInput,
    owner_id: String,
) -> Result<(StatusCode, Json<Task>), ApiError> {
    if input.prompt.trim().is_empty() {
        return Err(ApiError::bad_request("prompt cannot be empty"));
    }
    let bot_id = route_task(&input);
    let bot = state
        .bots
        .get(&bot_id)
        .cloned()
        .ok_or_else(|| ApiError::bad_request(format!("bot '{bot_id}' is not available")))?;
    let task = Task::queued_for(input, bot_id.clone(), owner_id);
    state
        .tasks
        .insert(task.clone())
        .await
        .map_err(ApiError::internal)?;

    let tasks = state.tasks.clone();
    let task_for_execution = task.clone();
    tokio::spawn(async move {
        let started = Instant::now();
        let progress = match bot_id.as_str() {
            "commerce" => {
                "Commerce is validating source-linked offers and preparing an approval boundary."
            }
            "flow" => {
                "Flow is validating an exact Monad transfer intent without signing or broadcasting."
            }
            "scout" => "Scout is fetching and reviewing the supplied sources.",
            "growth" => "Growth is applying the brand profile and drafting the campaign.",
            "operator" => "Operator is validating the dependency graph and preparing the plan.",
            _ => "Sentinel is analyzing the supplied bytecode.",
        };
        if let Err(error) = tasks
            .transition(
                task_for_execution.id,
                TaskStatus::Running,
                "running",
                progress,
            )
            .await
        {
            error!(task_id = %task_for_execution.id, %error, "could not persist running task");
            return;
        }

        let (status, kind, message) = match bot.execute(&task_for_execution).await {
            Ok(result) => {
                let message = result.summary.clone();
                (
                    TaskStatus::Completed {
                        summary: result.summary,
                        data: result.data,
                        latency_ms: elapsed_ms(started),
                    },
                    "completed",
                    message,
                )
            }
            Err(execution_error) => {
                error!(task_id = %task_for_execution.id, %execution_error, "bot task failed");
                let message = execution_error.to_string();
                (
                    TaskStatus::Failed {
                        error: message.clone(),
                        latency_ms: elapsed_ms(started),
                    },
                    "failed",
                    message,
                )
            }
        };
        if let Err(error) = tasks
            .transition(task_for_execution.id, status, kind, message)
            .await
        {
            error!(task_id = %task_for_execution.id, %error, "could not persist final task state");
        }
    });

    Ok((StatusCode::ACCEPTED, Json(task)))
}

async fn get_task(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<Uuid>,
) -> Result<Json<Task>, ApiError> {
    owned_task(&state, id, &principal.owner_id).await.map(Json)
}

async fn owned_task(state: &AppState, id: Uuid, owner_id: &str) -> Result<Task, ApiError> {
    state
        .tasks
        .get(id)
        .await
        .filter(|task| task.owner_id == owner_id)
        .ok_or_else(|| ApiError::not_found("task not found"))
}

async fn get_task_events(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<TaskEvent>>, ApiError> {
    owned_task(&state, id, &principal.owner_id)
        .await
        .map(|task| Json(task.events))
}

async fn record_feedback(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<Uuid>,
    Json(input): Json<FeedbackInput>,
) -> Result<Json<Task>, ApiError> {
    if !(1..=5).contains(&input.rating) {
        return Err(ApiError::bad_request("rating must be between 1 and 5"));
    }
    let note = input.note.map(|note| note.trim().to_owned());
    if note.as_ref().is_some_and(|note| note.len() > 1_000) {
        return Err(ApiError::bad_request(
            "feedback note must be 1,000 characters or fewer",
        ));
    }
    let task = owned_task(&state, id, &principal.owner_id).await?;
    if !matches!(task.status, TaskStatus::Completed { .. }) {
        return Err(ApiError::bad_request("feedback requires a completed task"));
    }
    state
        .tasks
        .record_feedback(id, TaskFeedback::new(input.rating, note))
        .await
        .map(Json)
        .map_err(ApiError::internal)
}

async fn list_routines(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
) -> Json<Vec<OperatorRoutine>> {
    Json(state.routines.list(&principal.owner_id).await)
}

async fn capture_routine(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(task_id): Path<Uuid>,
    Json(input): Json<RoutineCaptureInput>,
) -> Result<(StatusCode, Json<OperatorRoutine>), ApiError> {
    let id = input.id.trim();
    if id.is_empty()
        || id.len() > 40
        || !id.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
    {
        return Err(ApiError::bad_request(
            "routine id must use 1-40 lowercase letters, numbers, or hyphens",
        ));
    }
    let name = input.name.trim();
    if name.is_empty() || name.len() > 100 {
        return Err(ApiError::bad_request(
            "routine name must contain between 1 and 100 characters",
        ));
    }
    let description = input.description.trim();
    if description.len() > 500 {
        return Err(ApiError::bad_request(
            "routine description must be 500 characters or fewer",
        ));
    }

    owned_task(&state, task_id, &principal.owner_id).await?;
    let workflow = state
        .tasks
        .operator_workflow(task_id)
        .await
        .map_err(operator_api_error)?;
    if workflow.state != OperatorState::Completed {
        return Err(ApiError::conflict(
            "only a successfully completed Operator workflow can become a routine",
        ));
    }
    let operator_input = OperatorInput {
        objective: workflow.objective,
        target_date: workflow.target_date,
        steps: workflow
            .steps
            .into_iter()
            .map(|step| OperatorStepInput {
                id: step.id,
                title: step.title,
                bot: step.bot,
                prompt: step.prompt,
                input: step.input,
                depends_on: step.depends_on,
            })
            .collect(),
    };
    let now = unix_time_ms();
    let routine = OperatorRoutine {
        id: id.to_owned(),
        name: name.to_owned(),
        description: description.to_owned(),
        version: 1,
        created_at_ms: now,
        updated_at_ms: now,
        input: operator_input,
    };
    state
        .routines
        .save(&principal.owner_id, routine)
        .await
        .map(|saved| (StatusCode::CREATED, Json(saved)))
        .map_err(ApiError::internal)
}

async fn run_routine(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<Task>), ApiError> {
    let routine = state
        .routines
        .get(&principal.owner_id, &id)
        .await
        .ok_or_else(|| ApiError::not_found("routine not found"))?;
    let task_input = TaskInput {
        prompt: routine.input.objective.clone(),
        bot: Some("operator".into()),
        input: serde_json::to_value(routine.input).map_err(ApiError::internal)?,
    };
    enqueue_task(state, task_input, principal.owner_id).await
}

async fn flow_action(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<Uuid>,
    Json(action): Json<WorkflowAction>,
) -> Result<Json<FlowActionResponse>, ApiError> {
    owned_task(&state, id, &principal.owner_id).await?;
    if matches!(&action, WorkflowAction::Approve { .. }) {
        let workflow = state
            .tasks
            .flow_workflow(id)
            .await
            .map_err(flow_api_error)?;
        sentinel_check_flow(&workflow)?;
    }
    state
        .tasks
        .apply_flow_action(id, action)
        .await
        .map(Json)
        .map_err(|mutation_error| match mutation_error {
            FlowMutationError::NotFound => ApiError::not_found("Flow task not found"),
            FlowMutationError::InvalidTask(message) => ApiError::bad_request(message),
            FlowMutationError::Transition(FlowTransitionError::InvalidAction(message)) => {
                ApiError::bad_request(message)
            }
            FlowMutationError::Transition(FlowTransitionError::Conflict(message)) => {
                ApiError::conflict(message)
            }
            FlowMutationError::CorruptWorkflow(error) => ApiError::internal(error),
            FlowMutationError::Persistence(error) => ApiError::internal(error),
        })
}

async fn confirm_flow_transaction(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<Uuid>,
    Json(input): Json<FlowTransactionInput>,
) -> Result<Json<Task>, ApiError> {
    owned_task(&state, id, &principal.owner_id).await?;
    let workflow = state
        .tasks
        .flow_workflow(id)
        .await
        .map_err(flow_api_error)?;
    sentinel_check_flow(&workflow)?;
    let payout = workflow
        .payouts
        .first()
        .ok_or_else(|| ApiError::bad_request("Flow intent has no transfer"))?;
    let expected_value = mon_amount_to_wei(&payout.amount)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let transfer = state
        .chain
        .confirmed_native_transfer(&input.transaction_hash)
        .await
        .map_err(|error| ApiError::conflict(error.to_string()))?;
    if !transfer.from.eq_ignore_ascii_case(&workflow.payer) {
        return Err(ApiError::conflict(
            "confirmed transaction sender does not match the authorized wallet",
        ));
    }
    if !transfer.to.eq_ignore_ascii_case(&payout.recipient_address) {
        return Err(ApiError::conflict(
            "confirmed transaction recipient does not match the authorized intent",
        ));
    }
    if transfer.value_wei != expected_value.to_string() {
        return Err(ApiError::conflict(
            "confirmed transaction value does not match the authorized MON amount",
        ));
    }
    let workflow = confirm_execution(
        workflow,
        transfer.transaction_hash.clone(),
        transfer.block_number,
    )
    .map_err(flow_transition_api_error)?;
    state
        .tasks
        .save_flow_workflow(
            id,
            workflow,
            format!(
                "Monad confirmed transaction {} in block {}.",
                transfer.transaction_hash, transfer.block_number
            ),
        )
        .await
        .map(Json)
        .map_err(flow_api_error)
}

fn sentinel_check_flow(workflow: &PaymentWorkflow) -> Result<(), ApiError> {
    let payout = workflow
        .payouts
        .first()
        .ok_or_else(|| ApiError::bad_request("Flow intent has no transfer"))?;
    let amount = mon_amount_to_wei(&payout.amount)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    SentinelPolicyGuard::validate_native_transfer(&NativeTransferPolicyRequest {
        chain_id: workflow.chain_id,
        sender: workflow.payer.clone(),
        recipient: payout.recipient_address.clone(),
        asset: payout.asset.clone(),
        approved_amount_wei: amount,
        requested_amount_wei: amount,
    })
    .map(|_| ())
    .map_err(|error| ApiError::bad_request(error.to_string()))
}

async fn commerce_action(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<Uuid>,
    Json(action): Json<CommerceAction>,
) -> Result<Json<Task>, ApiError> {
    owned_task(&state, id, &principal.owner_id).await?;
    match action {
        CommerceAction::Approve {
            approved_total_atomic,
        } => approve_commerce_purchase(&state, id, approved_total_atomic).await,
        CommerceAction::Reject => {
            let mut workflow = state
                .tasks
                .commerce_workflow(id)
                .await
                .map_err(commerce_api_error)?;
            reject(&mut workflow).map_err(commerce_transition_api_error)?;
            state
                .tasks
                .save_commerce_workflow(
                    id,
                    CommerceState::AwaitingApproval,
                    workflow,
                    "Purchase rejected; no crypto transaction was created.",
                )
                .await
                .map(Json)
                .map_err(commerce_api_error)
        }
    }
}

async fn approve_commerce_purchase(
    state: &AppState,
    id: Uuid,
    approved_total_atomic: String,
) -> Result<Json<Task>, ApiError> {
    let mut workflow = state
        .tasks
        .commerce_workflow(id)
        .await
        .map_err(commerce_api_error)?;
    authorize(
        &mut workflow,
        Uuid::new_v4().to_string(),
        &approved_total_atomic,
    )
    .map_err(commerce_transition_api_error)?;
    state
        .tasks
        .save_commerce_workflow(
            id,
            CommerceState::AwaitingApproval,
            workflow,
            "Exact crypto offer authorized. No transaction was signed or broadcast.",
        )
        .await
        .map(Json)
        .map_err(commerce_api_error)
}

async fn operator_action(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<Uuid>,
    Json(action): Json<OperatorAction>,
) -> Result<Json<Task>, ApiError> {
    owned_task(&state, id, &principal.owner_id).await?;
    let should_run = matches!(&action, OperatorAction::Start | OperatorAction::RetryFailed);
    let task = state
        .tasks
        .apply_operator_action(id, action)
        .await
        .map_err(operator_api_error)?;
    if should_run {
        tokio::spawn(run_operator(state, id));
    }
    Ok(Json(task))
}

async fn run_operator(state: AppState, parent_id: Uuid) {
    loop {
        let workflow = match state.tasks.operator_workflow(parent_id).await {
            Ok(workflow) => workflow,
            Err(error) => {
                error!(task_id = %parent_id, %error, "could not load Operator workflow");
                return;
            }
        };
        if workflow.state == OperatorState::Cancelling {
            if let Err(error) = state.tasks.finalize_operator(parent_id).await {
                error!(task_id = %parent_id, %error, "could not finalize cancelled Operator run");
            }
            return;
        }
        if workflow.state != OperatorState::Running {
            return;
        }
        let runnable = workflow.runnable_steps();
        if runnable.is_empty() {
            if let Err(error) = state.tasks.finalize_operator(parent_id).await {
                error!(task_id = %parent_id, %error, "could not finalize Operator run");
            }
            return;
        }

        let mut wave = tokio::task::JoinSet::new();
        for step_index in runnable {
            wave.spawn(run_operator_step(
                state.clone(),
                parent_id,
                workflow.clone(),
                step_index,
            ));
        }
        while let Some(result) = wave.join_next().await {
            if let Err(error) = result {
                error!(task_id = %parent_id, %error, "Operator parallel step panicked");
            }
        }
    }
}

#[allow(clippy::too_many_lines)] // The full child lifecycle remains together so every persistent transition is auditable.
async fn run_operator_step(
    state: AppState,
    parent_id: Uuid,
    workflow: OperatorWorkflow,
    step_index: usize,
) {
    let Some(parent) = state.tasks.get(parent_id).await else {
        error!(task_id = %parent_id, "Operator parent task disappeared");
        return;
    };
    let step = workflow.steps[step_index].clone();
    let Some(bot) = state.bots.get(&step.bot).cloned() else {
        let message = format!("specialist '{}' is no longer registered", step.bot);
        if let Err(error) = state
            .tasks
            .mark_operator_step_result(parent_id, step_index, Err(message))
            .await
        {
            error!(task_id = %parent_id, %error, "could not record missing specialist");
        }
        return;
    };
    let child_input = materialize_operator_step_input(&state, &workflow, &step).await;
    let child = Task::queued_for(
        TaskInput {
            prompt: step.prompt,
            bot: Some(step.bot.clone()),
            input: child_input,
        },
        step.bot,
        parent.owner_id,
    );
    if let Err(error) = state.tasks.insert(child.clone()).await {
        let message = "Operator could not persist the child task.".to_owned();
        error!(task_id = %parent_id, child_task_id = %child.id, %error, "could not persist Operator child");
        if let Err(record_error) = state
            .tasks
            .mark_operator_step_result(parent_id, step_index, Err(message))
            .await
        {
            error!(task_id = %parent_id, %record_error, "could not record child persistence failure");
        }
        return;
    }
    match state
        .tasks
        .mark_operator_step_running(parent_id, step_index, child.id)
        .await
    {
        Ok(true) => {}
        Ok(false) => {
            let _ = state
                .tasks
                .transition(
                    child.id,
                    TaskStatus::Failed {
                        error: "Operator was cancelled before dispatch.".into(),
                        latency_ms: 0,
                    },
                    "cancelled",
                    "Child task was not dispatched because Operator was cancelled.",
                )
                .await;
            return;
        }
        Err(error) => {
            error!(task_id = %parent_id, %error, "could not persist Operator step start");
            return;
        }
    }

    let started = Instant::now();
    if let Err(error) = state
        .tasks
        .transition(
            child.id,
            TaskStatus::Running,
            "running",
            format!(
                "{} is executing an Operator child task.",
                bot.descriptor().name
            ),
        )
        .await
    {
        error!(task_id = %parent_id, child_task_id = %child.id, %error, "could not start Operator child");
        let _ = state
            .tasks
            .mark_operator_step_result(
                parent_id,
                step_index,
                Err("Child task could not enter the running state.".into()),
            )
            .await;
        return;
    }

    let parent_result = match bot.execute(&child).await {
        Ok(result) => {
            let summary = result.summary.clone();
            let status = TaskStatus::Completed {
                summary: result.summary,
                data: result.data,
                latency_ms: elapsed_ms(started),
            };
            if let Err(error) = state
                .tasks
                .transition(child.id, status, "completed", summary.clone())
                .await
            {
                error!(task_id = %parent_id, child_task_id = %child.id, %error, "could not persist completed Operator child");
                Err("Child result could not be persisted.".into())
            } else {
                Ok(summary)
            }
        }
        Err(execution_error) => {
            let message = execution_error.to_string();
            let status = TaskStatus::Failed {
                error: message.clone(),
                latency_ms: elapsed_ms(started),
            };
            if let Err(error) = state
                .tasks
                .transition(child.id, status, "failed", message.clone())
                .await
            {
                error!(task_id = %parent_id, child_task_id = %child.id, %error, "could not persist failed Operator child");
            }
            Err(message)
        }
    };
    if let Err(error) = state
        .tasks
        .mark_operator_step_result(parent_id, step_index, parent_result)
        .await
    {
        error!(task_id = %parent_id, %error, "could not persist Operator step result");
    }
}

async fn materialize_operator_step_input(
    state: &AppState,
    workflow: &OperatorWorkflow,
    step: &OperatorStep,
) -> serde_json::Value {
    if step.bot != "growth" {
        return step.input.clone();
    }
    let mut upstream_tasks = Vec::new();
    for dependency_id in &step.depends_on {
        let Some(dependency) = workflow
            .steps
            .iter()
            .find(|candidate| &candidate.id == dependency_id && candidate.bot == "scout")
        else {
            continue;
        };
        if let Some(task_id) = dependency.task_id
            && let Some(task) = state.tasks.get(task_id).await
        {
            upstream_tasks.push(task);
        }
    }
    materialize_growth_evidence(step.input.clone(), &upstream_tasks)
}

fn materialize_growth_evidence(
    mut input: serde_json::Value,
    upstream_tasks: &[Task],
) -> serde_json::Value {
    let Some(input_object) = input.as_object_mut() else {
        return input;
    };
    let evidence = input_object.entry("evidence").or_insert_with(|| json!([]));
    let Some(evidence_items) = evidence.as_array_mut() else {
        return input;
    };
    let mut seen: std::collections::HashSet<(String, String)> = evidence_items
        .iter()
        .filter_map(|item| {
            Some((
                item["text"].as_str()?.to_owned(),
                item["source_url"].as_str()?.to_owned(),
            ))
        })
        .collect();

    for task in upstream_tasks {
        let TaskStatus::Completed { data, .. } = &task.status else {
            continue;
        };
        let Some(findings) = data["report"]["findings"].as_array() else {
            continue;
        };
        let Some(sources) = data["report"]["sources"].as_array() else {
            continue;
        };
        for finding in findings {
            let Some(text) = finding["text"].as_str() else {
                continue;
            };
            let Some(citations) = finding["citations"].as_array() else {
                continue;
            };
            for citation in citations {
                let Some(source_id) = citation.as_u64() else {
                    continue;
                };
                let Some(source_url) = sources.iter().find_map(|source| {
                    (source["id"].as_u64() == Some(source_id)
                        && source["status"].as_str() == Some("fetched"))
                    .then(|| source["url"].as_str())
                    .flatten()
                }) else {
                    continue;
                };
                if seen.insert((text.to_owned(), source_url.to_owned())) {
                    evidence_items.push(json!({
                        "text": text,
                        "source_url": source_url
                    }));
                }
            }
        }
    }
    input
}

fn operator_api_error(error: OperatorMutationError) -> ApiError {
    match error {
        OperatorMutationError::NotFound => ApiError::not_found("Operator task not found"),
        OperatorMutationError::InvalidTask(message) => ApiError::bad_request(message),
        OperatorMutationError::Transition(OperatorTransitionError::InvalidAction(message)) => {
            ApiError::bad_request(message)
        }
        OperatorMutationError::Transition(OperatorTransitionError::Conflict(message)) => {
            ApiError::conflict(message)
        }
        OperatorMutationError::CorruptWorkflow(error) => ApiError::internal(error),
        OperatorMutationError::Persistence(error) => ApiError::internal(error),
    }
}

fn flow_transition_api_error(error: FlowTransitionError) -> ApiError {
    match error {
        FlowTransitionError::InvalidAction(message) => ApiError::bad_request(message),
        FlowTransitionError::Conflict(message) => ApiError::conflict(message),
    }
}

fn flow_api_error(error: FlowMutationError) -> ApiError {
    match error {
        FlowMutationError::NotFound => ApiError::not_found("Flow task not found"),
        FlowMutationError::InvalidTask(message) => ApiError::bad_request(message),
        FlowMutationError::Transition(error) => flow_transition_api_error(error),
        FlowMutationError::CorruptWorkflow(error) => ApiError::internal(error),
        FlowMutationError::Persistence(error) => ApiError::internal(error),
    }
}

fn commerce_transition_api_error(error: CommerceTransitionError) -> ApiError {
    match error {
        CommerceTransitionError::InvalidAction(message) => ApiError::bad_request(message),
        CommerceTransitionError::Conflict(message) => ApiError::conflict(message),
    }
}

fn commerce_api_error(error: CommerceMutationError) -> ApiError {
    match error {
        CommerceMutationError::NotFound => ApiError::not_found("Commerce task not found"),
        CommerceMutationError::InvalidTask(message) => ApiError::bad_request(message),
        CommerceMutationError::CorruptWorkflow(error) => ApiError::internal(error),
        CommerceMutationError::Transition(error) => commerce_transition_api_error(error),
        CommerceMutationError::Persistence(error) => ApiError::internal(error),
    }
}

async fn list_profiles(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
) -> Json<Vec<BrandProfile>> {
    Json(state.profiles.list(&principal.owner_id).await)
}

async fn get_profile(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<String>,
) -> Result<Json<BrandProfile>, ApiError> {
    state
        .profiles
        .get(&principal.owner_id, &id)
        .await
        .map(Json)
        .ok_or_else(|| ApiError::not_found("brand profile not found"))
}

async fn save_profile(
    State(state): State<AppState>,
    Extension(principal): Extension<AuthPrincipal>,
    Path(id): Path<String>,
    Json(mut profile): Json<BrandProfile>,
) -> Result<Json<BrandProfile>, ApiError> {
    validate_profile_id(&id)?;
    validate_profile(&profile)?;
    profile.id = id;
    state
        .profiles
        .save(&principal.owner_id, profile)
        .await
        .map(Json)
        .map_err(ApiError::internal)
}

fn validate_profile_id(id: &str) -> Result<(), ApiError> {
    if id.is_empty()
        || id.len() > 64
        || !id.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
    {
        return Err(ApiError::bad_request(
            "profile id must use 1-64 lowercase letters, numbers, or hyphens",
        ));
    }
    Ok(())
}

fn validate_profile(profile: &BrandProfile) -> Result<(), ApiError> {
    for (label, value) in [
        ("project_name", profile.project_name.as_str()),
        ("product_description", profile.product_description.as_str()),
        ("target_audience", profile.target_audience.as_str()),
        ("preferred_tone", profile.preferred_tone.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(ApiError::bad_request(format!("{label} cannot be empty")));
        }
        if value.len() > 2_000 {
            return Err(ApiError::bad_request(format!("{label} is too long")));
        }
    }
    if profile.value_propositions.is_empty() || profile.value_propositions.len() > 10 {
        return Err(ApiError::bad_request(
            "value_propositions must contain between 1 and 10 items",
        ));
    }
    Ok(())
}

fn route_task(input: &TaskInput) -> String {
    input.bot.clone().unwrap_or_else(|| "scout".into())
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn unix_time_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}

struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn internal(error: impl std::fmt::Display) -> Self {
        error!(%error, "internal API error");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "The task could not be saved. Try again.".into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (self.status, Json(json!({"error": self.message}))).into_response()
    }
}

async fn shutdown() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        warn!(%error, "failed to install shutdown signal handler");
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use bot_flow::{Flow, WorkflowAction};
    use bot_growth::BrandProfile;
    use bot_operator::{
        Operator, OperatorAction, OperatorInput, OperatorState, OperatorStepInput,
        OperatorStepStatus,
    };
    use donads_core::{Bot, Task, TaskFeedback, TaskInput, TaskStatus};
    use serde_json::{Value, json};
    use uuid::Uuid;

    use super::{
        OperatorRoutine, PersistentProfileStore, PersistentRoutineStore, PersistentTaskStore,
        materialize_growth_evidence, route_task,
    };

    fn temporary_store_path() -> PathBuf {
        std::env::temp_dir().join(format!("donads-task-store-{}.json", Uuid::new_v4()))
    }

    fn brand_profile() -> BrandProfile {
        BrandProfile {
            id: "donads".into(),
            project_name: "DONADS".into(),
            product_description: "AI workforce for Monad teams".into(),
            target_audience: "Web3 founders".into(),
            preferred_tone: "precise".into(),
            terminology: vec!["agent".into()],
            value_propositions: vec!["Durable execution".into()],
            approved_links: vec!["https://example.com".into()],
            prohibited_terms: Vec::new(),
            previous_approved_examples: Vec::new(),
            version: 0,
            updated_at_ms: 0,
        }
    }

    #[test]
    fn defaults_to_scout() {
        let input = TaskInput {
            prompt: "research this".into(),
            bot: None,
            input: Value::Null,
        };
        assert_eq!(route_task(&input), "scout");
    }

    #[test]
    fn operator_materializes_deduplicated_scout_evidence_for_growth() {
        let mut scout = Task::queued(
            TaskInput {
                prompt: "research".into(),
                bot: Some("scout".into()),
                input: json!({"sources": ["https://example.com"]}),
            },
            "scout".into(),
        );
        scout.status = TaskStatus::Completed {
            summary: "done".into(),
            data: json!({
                "report": {
                    "findings": [{
                        "text": "Example Domain is reserved for documentation.",
                        "citations": [1]
                    }],
                    "sources": [{
                        "id": 1,
                        "url": "https://example.com/",
                        "status": "fetched"
                    }]
                }
            }),
            latency_ms: 1,
        };
        let input = json!({
            "objective": "Draft a campaign",
            "evidence": [{
                "text": "Existing evidence",
                "source_url": "https://existing.example/"
            }]
        });
        let materialized = materialize_growth_evidence(input, &[scout.clone(), scout]);
        let evidence = materialized["evidence"]
            .as_array()
            .expect("evidence should remain an array");
        assert_eq!(evidence.len(), 2);
        assert_eq!(
            evidence[1],
            json!({
                "text": "Example Domain is reserved for documentation.",
                "source_url": "https://example.com/"
            })
        );
    }

    #[tokio::test]
    async fn completed_tasks_survive_reload() {
        let path = temporary_store_path();
        let store = PersistentTaskStore::load(path.clone())
            .await
            .expect("store should load");
        let task = Task::queued(
            TaskInput {
                prompt: "research".into(),
                bot: Some("scout".into()),
                input: json!({"sources": ["https://example.com"]}),
            },
            "scout".into(),
        );
        let id = task.id;
        store.insert(task).await.expect("task should persist");
        store
            .transition(
                id,
                TaskStatus::Completed {
                    summary: "done".into(),
                    data: json!({"ok": true}),
                    latency_ms: 7,
                },
                "completed",
                "done",
            )
            .await
            .expect("transition should persist");
        store
            .record_feedback(id, TaskFeedback::new(5, Some("useful".into())))
            .await
            .expect("feedback should persist");

        let reloaded = PersistentTaskStore::load(path.clone())
            .await
            .expect("store should reload");
        let recovered = reloaded.get(id).await.expect("task should survive reload");
        assert!(matches!(recovered.status, TaskStatus::Completed { .. }));
        assert_eq!(recovered.events.len(), 2);
        assert_eq!(recovered.feedback.map(|feedback| feedback.rating), Some(5));
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn task_history_is_scoped_to_the_authenticated_owner() {
        let path = temporary_store_path();
        let store = PersistentTaskStore::load(path.clone())
            .await
            .expect("store should load");
        for (owner, prompt) in [("owner-a", "first"), ("owner-b", "private")] {
            store
                .insert(Task::queued_for(
                    TaskInput {
                        prompt: prompt.into(),
                        bot: Some("scout".into()),
                        input: json!({"sources": ["https://example.com"]}),
                    },
                    "scout".into(),
                    owner.into(),
                ))
                .await
                .expect("task should persist");
        }
        let owner_a = store.list("owner-a", 50).await;
        assert_eq!(owner_a.len(), 1);
        assert_eq!(owner_a[0].prompt, "first");
        assert!(store.list("unknown", 50).await.is_empty());
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn running_tasks_become_failed_after_restart() {
        let path = temporary_store_path();
        let store = PersistentTaskStore::load(path.clone())
            .await
            .expect("store should load");
        let task = Task::queued(
            TaskInput {
                prompt: "research".into(),
                bot: Some("scout".into()),
                input: json!({"sources": ["https://example.com"]}),
            },
            "scout".into(),
        );
        let id = task.id;
        store.insert(task).await.expect("task should persist");
        store
            .transition(id, TaskStatus::Running, "running", "working")
            .await
            .expect("running state should persist");

        let reloaded = PersistentTaskStore::load(path.clone())
            .await
            .expect("store should reload");
        let recovered = reloaded.get(id).await.expect("task should survive reload");
        assert!(matches!(recovered.status, TaskStatus::Failed { .. }));
        assert_eq!(
            recovered.events.last().map(|event| event.kind.as_str()),
            Some("recovered")
        );
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn brand_profiles_are_versioned_and_survive_reload() {
        let path = temporary_store_path();
        let store = PersistentProfileStore::load(path.clone())
            .await
            .expect("profile store should load");
        let first = store
            .save("owner-a", brand_profile())
            .await
            .expect("profile should save");
        assert_eq!(first.version, 1);
        let second = store
            .save("owner-a", brand_profile())
            .await
            .expect("profile should update");
        assert_eq!(second.version, 2);

        let reloaded = PersistentProfileStore::load(path.clone())
            .await
            .expect("profile store should reload");
        assert_eq!(
            reloaded
                .get("owner-a", "donads")
                .await
                .map(|profile| profile.version),
            Some(2)
        );
        assert!(reloaded.get("owner-b", "donads").await.is_none());
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn operator_routines_are_versioned_and_survive_reload() {
        let path = temporary_store_path();
        let store = PersistentRoutineStore::load(path.clone())
            .await
            .expect("routine store should load");
        let routine = OperatorRoutine {
            id: "research-draft".into(),
            name: "Research and draft".into(),
            description: "Reusable approved workflow".into(),
            version: 1,
            created_at_ms: 1,
            updated_at_ms: 1,
            input: OperatorInput {
                objective: "Research and draft".into(),
                target_date: None,
                steps: vec![OperatorStepInput {
                    id: "research".into(),
                    title: "Research".into(),
                    bot: "scout".into(),
                    prompt: "Review source".into(),
                    input: json!({"sources": ["https://example.com"]}),
                    depends_on: Vec::new(),
                }],
            },
        };
        assert_eq!(
            store
                .save("owner-a", routine.clone())
                .await
                .expect("save")
                .version,
            1
        );
        assert_eq!(
            store
                .save("owner-a", routine)
                .await
                .expect("update")
                .version,
            2
        );

        let reloaded = PersistentRoutineStore::load(path.clone())
            .await
            .expect("routine store should reload");
        assert_eq!(
            reloaded
                .get("owner-a", "research-draft")
                .await
                .map(|routine| routine.version),
            Some(2)
        );
        assert!(reloaded.get("owner-b", "research-draft").await.is_none());
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn flow_authorization_persists_after_reload() {
        let path = temporary_store_path();
        let store = PersistentTaskStore::load(path.clone())
            .await
            .expect("store should load");
        let task = Task::queued(
            TaskInput {
                prompt: "Create a bounty".into(),
                bot: Some("flow".into()),
                input: json!({
                    "title": "Asset bounty",
                    "purpose": "Pay after approval",
                    "payer": "0x2222222222222222222222222222222222222222",
                    "payouts": [{
                        "recipient_name": "Contributor",
                        "recipient_address": "0x1111111111111111111111111111111111111111",
                        "asset": "MON",
                        "amount": "1",
                        "milestone": "Deliver assets",
                        "deadline": null
                    }],
                    "approval_conditions": [],
                    "linked_task_id": null
                }),
            },
            "flow".into(),
        );
        let id = task.id;
        let result = Flow
            .execute(&task)
            .await
            .expect("Flow should prepare workflow");
        store.insert(task).await.expect("task should persist");
        store
            .transition(
                id,
                TaskStatus::Completed {
                    summary: result.summary,
                    data: result.data,
                    latency_ms: 1,
                },
                "completed",
                "Flow prepared workflow",
            )
            .await
            .expect("result should persist");
        store
            .apply_flow_action(id, WorkflowAction::Approve { note: None })
            .await
            .expect("approval should persist");

        let reloaded = PersistentTaskStore::load(path.clone())
            .await
            .expect("store should reload");
        let task = reloaded.get(id).await.expect("task should reload");
        let workflow_state = match task.status {
            TaskStatus::Completed { data, .. } => data["workflow"]["state"].clone(),
            _ => panic!("Flow task should remain completed"),
        };
        assert_eq!(workflow_state, "authorized");
        let _ = tokio::fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn operator_control_actions_survive_reload() {
        let path = temporary_store_path();
        let store = PersistentTaskStore::load(path.clone())
            .await
            .expect("store should load");
        let task = Task::queued(
            TaskInput {
                prompt: "Research then draft".into(),
                bot: Some("operator".into()),
                input: json!({
                    "objective": "Research then draft",
                    "target_date": null,
                    "steps": [{
                        "id": "research",
                        "title": "Research",
                        "bot": "scout",
                        "prompt": "Review the source",
                        "input": {"sources": ["https://example.com"]},
                        "depends_on": []
                    }]
                }),
            },
            "operator".into(),
        );
        let id = task.id;
        let result = Operator
            .execute(&task)
            .await
            .expect("Operator should prepare plan");
        store.insert(task).await.expect("task should persist");
        store
            .transition(
                id,
                TaskStatus::Completed {
                    summary: result.summary,
                    data: result.data,
                    latency_ms: 1,
                },
                "completed",
                "Operator prepared plan",
            )
            .await
            .expect("plan should persist");
        store
            .apply_operator_action(id, OperatorAction::Start)
            .await
            .expect("plan should start");
        let interrupted = PersistentTaskStore::load(path.clone())
            .await
            .expect("running plan should recover");
        let recovered = interrupted
            .operator_workflow(id)
            .await
            .expect("recovered workflow should load");
        assert_eq!(recovered.state, OperatorState::Failed);
        assert_eq!(recovered.steps[0].status, OperatorStepStatus::Blocked);
        interrupted
            .apply_operator_action(id, OperatorAction::RetryFailed)
            .await
            .expect("recovered work should be retryable");
        interrupted
            .apply_operator_action(id, OperatorAction::Cancel)
            .await
            .expect("cancellation should persist");

        let reloaded = PersistentTaskStore::load(path.clone())
            .await
            .expect("store should reload");
        let workflow = reloaded
            .operator_workflow(id)
            .await
            .expect("workflow should survive reload");
        assert_eq!(workflow.state, OperatorState::Cancelled);
        assert!(workflow.cancellation_requested);
        let _ = tokio::fs::remove_file(path).await;
    }
}
