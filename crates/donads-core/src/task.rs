use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// User input accepted by the task creation endpoint.
#[derive(Clone, Debug, Deserialize)]
pub struct TaskInput {
    /// Natural-language request shown in the chat.
    pub prompt: String,
    /// Optional explicit bot selection. Omit to use the router.
    pub bot: Option<String>,
    /// Structured bot-specific input.
    #[serde(default)]
    pub input: Value,
}

/// Lifecycle of a dispatched task.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TaskStatus {
    /// The task is waiting to execute.
    Queued,
    /// The selected bot is processing the task.
    Running,
    /// The bot completed successfully.
    Completed {
        /// Conversational summary.
        summary: String,
        /// Structured result payload.
        data: Value,
        /// End-to-end server execution time.
        latency_ms: u64,
    },
    /// The task could not be completed.
    Failed {
        /// Safe error message suitable for the client.
        error: String,
        /// End-to-end server execution time.
        latency_ms: u64,
    },
}

/// A durable, user-visible lifecycle event for a task.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskEvent {
    /// Monotonic sequence number within the task.
    pub sequence: u32,
    /// Stable event category used by clients.
    pub kind: String,
    /// Short progress message safe to show in the interface.
    pub message: String,
    /// Unix timestamp in milliseconds.
    pub at_ms: u64,
}

/// User evaluation captured for later, versioned quality comparisons.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TaskFeedback {
    /// Quality rating from one (poor) to five (excellent).
    pub rating: u8,
    /// Optional correction or explanation from the user.
    pub note: Option<String>,
    /// Unix timestamp in milliseconds.
    pub submitted_at_ms: u64,
}

impl TaskFeedback {
    /// Creates feedback after the API has validated the rating and note.
    #[must_use]
    pub fn new(rating: u8, note: Option<String>) -> Self {
        Self {
            rating,
            note,
            submitted_at_ms: unix_time_ms(),
        }
    }
}

/// A task routed to one specialist bot.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Task {
    /// Globally unique task identifier.
    pub id: Uuid,
    /// Authenticated wallet address that owns this task and its history.
    #[serde(default = "legacy_owner_id")]
    pub owner_id: String,
    /// Original natural-language request.
    pub prompt: String,
    /// Selected bot identifier.
    pub bot: String,
    /// Structured input supplied to the bot.
    pub input: Value,
    /// Current execution status.
    pub status: TaskStatus,
    /// Durable execution history in chronological order.
    #[serde(default)]
    pub events: Vec<TaskEvent>,
    /// Unix timestamp in milliseconds when the task was accepted.
    pub created_at_ms: u64,
    /// Unix timestamp in milliseconds when the task last changed.
    pub updated_at_ms: u64,
    /// Latest user evaluation for this exact agent result and version.
    #[serde(default)]
    pub feedback: Option<TaskFeedback>,
}

impl Task {
    /// Creates a queued task after routing has selected a bot.
    #[must_use]
    pub fn queued(input: TaskInput, bot: String) -> Self {
        Self::queued_for(input, bot, legacy_owner_id())
    }

    /// Creates a queued task owned by one authenticated principal.
    #[must_use]
    pub fn queued_for(input: TaskInput, bot: String, owner_id: String) -> Self {
        let now = unix_time_ms();
        Self {
            id: Uuid::new_v4(),
            owner_id,
            prompt: input.prompt,
            bot,
            input: input.input,
            status: TaskStatus::Queued,
            events: vec![TaskEvent {
                sequence: 1,
                kind: "queued".into(),
                message: "Task accepted and queued.".into(),
                at_ms: now,
            }],
            created_at_ms: now,
            updated_at_ms: now,
            feedback: None,
        }
    }

    /// Changes status and appends a durable progress event.
    pub fn transition(
        &mut self,
        status: TaskStatus,
        kind: impl Into<String>,
        message: impl Into<String>,
    ) {
        let now = unix_time_ms();
        self.status = status;
        self.updated_at_ms = now;
        self.events.push(TaskEvent {
            sequence: u32::try_from(self.events.len() + 1).unwrap_or(u32::MAX),
            kind: kind.into(),
            message: message.into(),
            at_ms: now,
        });
    }

    /// Records user evaluation without changing the execution result.
    pub fn record_feedback(&mut self, feedback: TaskFeedback) {
        self.updated_at_ms = feedback.submitted_at_ms;
        self.feedback = Some(feedback);
    }
}

fn legacy_owner_id() -> String {
    "legacy-local".into()
}

fn unix_time_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
        })
}
