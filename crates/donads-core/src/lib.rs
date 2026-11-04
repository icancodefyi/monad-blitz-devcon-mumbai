//! Shared contracts for DONADS bots and the dispatch service.

mod bot;
mod chain;
mod task;

pub use bot::{Bot, BotDescriptor, BotError, BotResult};
pub use chain::{ChainClient, ChainError, ConfirmedNativeTransfer, Network, NetworkStatus};
pub use task::{Task, TaskEvent, TaskFeedback, TaskInput, TaskStatus};
