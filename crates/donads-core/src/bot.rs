use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::Task;

/// Static metadata exposed by a registered bot.
#[derive(Clone, Debug, Serialize)]
pub struct BotDescriptor {
    /// Stable lowercase identifier used by the API.
    pub id: &'static str,
    /// User-facing name.
    pub name: &'static str,
    /// Short statement of the bot's sole responsibility.
    pub specialty: &'static str,
    /// Whether this bot is ready to accept tasks.
    pub available: bool,
}

/// Successful output returned by a bot.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BotResult {
    /// Human-readable response for the conversation.
    pub summary: String,
    /// Machine-readable result for UI rendering and composition.
    pub data: Value,
}

/// Errors that a bot may return without terminating the dispatcher.
#[derive(Debug, Error)]
pub enum BotError {
    /// The request did not contain the data required by the bot.
    #[error("invalid bot input: {0}")]
    InvalidInput(String),
    /// Analysis could not be completed.
    #[error("analysis failed: {0}")]
    Analysis(String),
}

/// Common execution contract implemented by every DONADS bot.
#[async_trait]
pub trait Bot: Send + Sync {
    /// Returns stable metadata used by routing and discovery.
    fn descriptor(&self) -> BotDescriptor;

    /// Executes one idempotent task.
    async fn execute(&self, task: &Task) -> Result<BotResult, BotError>;
}
