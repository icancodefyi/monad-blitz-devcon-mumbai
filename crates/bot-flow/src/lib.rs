//! Exact Monad transfer-intent preparation. This crate never fabricates execution.

use async_trait::async_trait;
use donads_core::{Bot, BotDescriptor, BotError, BotResult, Task};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};
use thiserror::Error;

pub const AGENT_VERSION: &str = "flow-crypto-intent-v1";
const MONAD_TESTNET_CHAIN_ID: u64 = 10_143;
const MAX_TRANSFERS: usize = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FlowInput {
    pub title: String,
    pub purpose: String,
    pub payer: String,
    pub payouts: Vec<PayoutDraft>,
    #[serde(default)]
    pub approval_conditions: Vec<String>,
    pub linked_task_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PayoutDraft {
    pub recipient_name: String,
    pub recipient_address: String,
    pub asset: String,
    pub amount: String,
    pub milestone: String,
    pub deadline: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct PaymentWorkflow {
    pub id: String,
    pub title: String,
    pub purpose: String,
    pub payer: String,
    pub network: String,
    pub chain_id: u64,
    pub state: WorkflowState,
    pub payouts: Vec<PayoutDraft>,
    pub totals: Vec<AssetTotal>,
    pub approval_conditions: Vec<String>,
    pub linked_task_id: Option<String>,
    pub approval: Option<ApprovalRecord>,
    pub execution: Option<ExecutionRecord>,
    pub audit_history: Vec<AuditRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowState {
    AwaitingApproval,
    Authorized,
    Confirmed,
    Rejected,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct AssetTotal {
    pub asset: String,
    pub amount: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ApprovalRecord {
    pub decision: String,
    pub note: String,
    pub decided_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct ExecutionRecord {
    pub transaction_hash: String,
    pub block_number: u64,
    pub confirmed_at_ms: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct AuditRecord {
    pub sequence: u32,
    pub event: String,
    pub detail: String,
    pub at_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum WorkflowAction {
    Approve { note: Option<String> },
    Reject { reason: String },
}

pub struct TransitionOutcome {
    pub workflow: PaymentWorkflow,
    pub duplicate_prevented: bool,
    pub message: String,
}

#[derive(Debug, Error)]
pub enum FlowTransitionError {
    #[error("invalid workflow action: {0}")]
    InvalidAction(String),
    #[error("workflow action conflicts with current state: {0}")]
    Conflict(String),
}

#[derive(Default)]
pub struct Flow;

#[async_trait]
impl Bot for Flow {
    fn descriptor(&self) -> BotDescriptor {
        BotDescriptor {
            id: "flow",
            name: "Flow",
            specialty: "Exact Monad transfer intents; wallet execution pending",
            available: true,
        }
    }
    async fn execute(&self, task: &Task) -> Result<BotResult, BotError> {
        let input: FlowInput = serde_json::from_value(task.input.clone()).map_err(|e| {
            BotError::InvalidInput(format!(
                "Flow requires a structured crypto transfer intent: {e}"
            ))
        })?;
        validate_input(&input)?;
        let totals = calculate_totals(&input.payouts)?;
        let workflow = PaymentWorkflow {
            id: format!("flow-{}", task.id),
            title: input.title,
            purpose: input.purpose,
            payer: input.payer,
            network: "Monad Testnet".into(),
            chain_id: MONAD_TESTNET_CHAIN_ID,
            state: WorkflowState::AwaitingApproval,
            payouts: input.payouts,
            totals,
            approval_conditions: input.approval_conditions,
            linked_task_id: input.linked_task_id,
            approval: None,
            execution: None,
            audit_history: vec![AuditRecord {
                sequence: 1,
                event: "intent_created".into(),
                detail: "Exact crypto transfer intent created; nothing was signed or broadcast."
                    .into(),
                at_ms: unix_time_ms(),
            }],
        };
        Ok(BotResult {
            summary: format!(
                "Flow prepared {} exact Monad transfer intent(s). No transaction was signed or broadcast.",
                workflow.payouts.len()
            ),
            data: json!({"workflow": workflow, "agent_version": AGENT_VERSION, "execution_available": false, "blocked_reason": "A wallet signer and confirmed transaction receipt path are not implemented."}),
        })
    }
}

pub fn apply_action(
    mut workflow: PaymentWorkflow,
    action: WorkflowAction,
) -> Result<TransitionOutcome, FlowTransitionError> {
    if workflow.state != WorkflowState::AwaitingApproval {
        return Err(FlowTransitionError::Conflict(
            "only an awaiting-approval intent can be changed".into(),
        ));
    }
    let (event, message, decision, note, state) = match action {
        WorkflowAction::Approve { note } => (
            "intent_authorized",
            "Exact transfer intent authorized. Execution remains unavailable until a real wallet signer is connected.",
            "approved",
            validate_note(
                &note.unwrap_or_else(|| "Transfer intent approved.".into()),
                "approval note",
            )?,
            WorkflowState::Authorized,
        ),
        WorkflowAction::Reject { reason } => (
            "intent_rejected",
            "Transfer intent rejected; no transaction was created.",
            "rejected",
            validate_note(&reason, "rejection reason")?,
            WorkflowState::Rejected,
        ),
    };
    let now = unix_time_ms();
    workflow.approval = Some(ApprovalRecord {
        decision: decision.into(),
        note,
        decided_at_ms: now,
    });
    workflow.state = state;
    push_audit(&mut workflow, event, message, now);
    Ok(TransitionOutcome {
        workflow,
        duplicate_prevented: false,
        message: message.into(),
    })
}

/// Records execution only after the dispatcher has independently verified the
/// transaction and receipt through the configured Monad RPC endpoint.
pub fn confirm_execution(
    mut workflow: PaymentWorkflow,
    transaction_hash: String,
    block_number: u64,
) -> Result<PaymentWorkflow, FlowTransitionError> {
    if workflow.state != WorkflowState::Authorized {
        return Err(FlowTransitionError::Conflict(
            "transaction confirmation requires an authorized intent".into(),
        ));
    }
    if transaction_hash.len() != 66
        || !transaction_hash.starts_with("0x")
        || !transaction_hash[2..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(FlowTransitionError::InvalidAction(
            "transaction hash must contain 32 hexadecimal bytes".into(),
        ));
    }
    let now = unix_time_ms();
    workflow.execution = Some(ExecutionRecord {
        transaction_hash: transaction_hash.clone(),
        block_number,
        confirmed_at_ms: now,
    });
    workflow.state = WorkflowState::Confirmed;
    push_audit(
        &mut workflow,
        "transaction_confirmed",
        &format!("Monad RPC verified transaction {transaction_hash} in block {block_number}."),
        now,
    );
    Ok(workflow)
}

fn validate_input(input: &FlowInput) -> Result<(), BotError> {
    for (label, value) in [
        ("title", input.title.as_str()),
        ("purpose", input.purpose.as_str()),
        ("payer", input.payer.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(BotError::InvalidInput(format!("{label} cannot be empty")));
        }
    }
    if input.payouts.is_empty() || input.payouts.len() > MAX_TRANSFERS {
        return Err(BotError::InvalidInput(format!(
            "payouts must contain between 1 and {MAX_TRANSFERS} items"
        )));
    }
    validate_address(&input.payer)?;
    let mut unique = HashSet::new();
    for payout in &input.payouts {
        validate_address(&payout.recipient_address)?;
        parse_amount(&payout.amount)?;
        if !payout.asset.eq_ignore_ascii_case("MON") {
            return Err(BotError::InvalidInput(
                "the first real execution path supports native MON only".into(),
            ));
        }
        if payout.recipient_name.trim().is_empty()
            || payout.asset.trim().is_empty()
            || payout.milestone.trim().is_empty()
        {
            return Err(BotError::InvalidInput(
                "recipient_name, asset, and milestone cannot be empty".into(),
            ));
        }
        let key = format!(
            "{}:{}:{}",
            payout.recipient_address.to_ascii_lowercase(),
            payout.asset.to_ascii_uppercase(),
            payout.milestone.to_ascii_lowercase()
        );
        if !unique.insert(key) {
            return Err(BotError::InvalidInput(
                "duplicate recipient, asset, and milestone transfer".into(),
            ));
        }
    }
    Ok(())
}

fn validate_address(address: &str) -> Result<(), BotError> {
    let hex = address
        .strip_prefix("0x")
        .ok_or_else(|| BotError::InvalidInput("recipient addresses must start with 0x".into()))?;
    if hex.len() != 40 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(BotError::InvalidInput(
            "recipient addresses must contain exactly 40 hexadecimal characters".into(),
        ));
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct DecimalAmount {
    units: u128,
    scale: u32,
}
fn parse_amount(value: &str) -> Result<DecimalAmount, BotError> {
    let value = value.trim();
    let (whole, fraction) = value.split_once('.').unwrap_or((value, ""));
    if whole.is_empty()
        || whole.len() > 30
        || fraction.len() > 18
        || !whole.chars().all(|c| c.is_ascii_digit())
        || !fraction.chars().all(|c| c.is_ascii_digit())
    {
        return Err(BotError::InvalidInput(
            "amount must be a positive decimal with up to 18 decimal places".into(),
        ));
    }
    let units = format!("{whole}{fraction}")
        .parse::<u128>()
        .map_err(|_| BotError::InvalidInput("amount is too large".into()))?;
    if units == 0 {
        return Err(BotError::InvalidInput(
            "amount must be greater than zero".into(),
        ));
    }
    Ok(DecimalAmount {
        units,
        scale: u32::try_from(fraction.len()).unwrap_or(18),
    })
}

/// Converts a human-readable MON amount into its exact 18-decimal wei value.
pub fn mon_amount_to_wei(value: &str) -> Result<u128, BotError> {
    let amount = parse_amount(value)?;
    amount
        .units
        .checked_mul(
            10_u128
                .checked_pow(18 - amount.scale)
                .ok_or_else(|| BotError::InvalidInput("amount scale overflow".into()))?,
        )
        .ok_or_else(|| BotError::InvalidInput("amount is too large".into()))
}
fn calculate_totals(payouts: &[PayoutDraft]) -> Result<Vec<AssetTotal>, BotError> {
    let mut assets = Vec::<(String, Vec<DecimalAmount>)>::new();
    for p in payouts {
        let asset = p.asset.trim().to_ascii_uppercase();
        let amount = parse_amount(&p.amount)?;
        if let Some((_, v)) = assets.iter_mut().find(|(a, _)| *a == asset) {
            v.push(amount)
        } else {
            assets.push((asset, vec![amount]))
        }
    }
    assets.sort_by(|a, b| a.0.cmp(&b.0));
    assets
        .into_iter()
        .map(|(asset, amounts)| {
            let scale = amounts.iter().map(|a| a.scale).max().unwrap_or(0);
            let units = amounts.into_iter().try_fold(0_u128, |total, a| {
                let factor = 10_u128
                    .checked_pow(scale - a.scale)
                    .ok_or_else(|| BotError::InvalidInput("amount scale overflow".into()))?;
                total
                    .checked_add(a.units.checked_mul(factor).ok_or_else(|| {
                        BotError::InvalidInput("amount total is too large".into())
                    })?)
                    .ok_or_else(|| BotError::InvalidInput("amount total is too large".into()))
            })?;
            Ok(AssetTotal {
                asset,
                amount: format_amount(units, scale),
            })
        })
        .collect()
}
fn format_amount(units: u128, scale: u32) -> String {
    if scale == 0 {
        return units.to_string();
    }
    let factor = 10_u128.pow(scale);
    let whole = units / factor;
    let fraction = format!(
        "{:0width$}",
        units % factor,
        width = usize::try_from(scale).unwrap_or(18)
    );
    let trimmed = fraction.trim_end_matches('0');
    if trimmed.is_empty() {
        whole.to_string()
    } else {
        format!("{whole}.{trimmed}")
    }
}
fn validate_note(value: &str, label: &str) -> Result<String, FlowTransitionError> {
    let value = value.trim().to_owned();
    if value.is_empty() || value.len() > 2_000 {
        return Err(FlowTransitionError::InvalidAction(format!(
            "{label} must contain 1-2,000 characters"
        )));
    }
    Ok(value)
}
fn push_audit(workflow: &mut PaymentWorkflow, event: &str, detail: &str, at_ms: u64) {
    workflow.audit_history.push(AuditRecord {
        sequence: u32::try_from(workflow.audit_history.len() + 1).unwrap_or(u32::MAX),
        event: event.into(),
        detail: detail.into(),
        at_ms,
    })
}
fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::{Flow, PaymentWorkflow, WorkflowAction, WorkflowState, apply_action};
    use donads_core::{Bot, Task, TaskInput};
    use serde_json::json;
    fn task() -> Task {
        Task::queued(
            TaskInput {
                prompt: "Pay contributor".into(),
                bot: Some("flow".into()),
                input: json!({"title":"Bounty","purpose":"Pay approved work","payer":"0x2222222222222222222222222222222222222222","payouts":[{"recipient_name":"Contributor","recipient_address":"0x1111111111111111111111111111111111111111","asset":"MON","amount":"1.25","milestone":"Approved delivery","deadline":null}],"approval_conditions":["Delivery approved"],"linked_task_id":null}),
            },
            "flow".into(),
        )
    }
    #[tokio::test]
    async fn creates_intent_without_execution() {
        let result = Flow.execute(&task()).await.expect("intent");
        assert_eq!(result.data["execution_available"], false);
        assert!(result.data.get("simulation_only").is_none());
    }
    #[tokio::test]
    async fn authorizes_without_claiming_broadcast() {
        let result = Flow.execute(&task()).await.expect("intent");
        let workflow: PaymentWorkflow =
            serde_json::from_value(result.data["workflow"].clone()).expect("workflow");
        let outcome =
            apply_action(workflow, WorkflowAction::Approve { note: None }).expect("approve");
        assert_eq!(outcome.workflow.state, WorkflowState::Authorized);
        assert!(outcome.message.contains("unavailable"));
    }

    #[tokio::test]
    async fn records_only_a_verified_confirmation_after_authorization() {
        let result = Flow.execute(&task()).await.expect("intent");
        let workflow: PaymentWorkflow =
            serde_json::from_value(result.data["workflow"].clone()).expect("workflow");
        let workflow = apply_action(workflow, WorkflowAction::Approve { note: None })
            .expect("approve")
            .workflow;
        let confirmed = super::confirm_execution(workflow, format!("0x{}", "ab".repeat(32)), 123)
            .expect("verified receipt should record");
        assert_eq!(confirmed.state, WorkflowState::Confirmed);
        assert_eq!(confirmed.execution.expect("execution").block_number, 123);
    }

    #[test]
    fn converts_mon_to_exact_wei() {
        assert_eq!(
            super::mon_amount_to_wei("1.25").expect("amount"),
            1_250_000_000_000_000_000
        );
    }
}
