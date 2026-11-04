//! Crypto-native purchase preparation with explicit authorization and no simulated checkout.

use async_trait::async_trait;
use donads_core::{Bot, BotDescriptor, BotError, BotResult, Task};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use url::Url;

pub const AGENT_VERSION: &str = "commerce-crypto-order-v2";
const MAX_OFFERS: usize = 10;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CommerceInput {
    pub objective: String,
    pub budget_atomic: String,
    pub asset: String,
    pub offers: Vec<ProductOffer>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ProductOffer {
    pub id: String,
    pub name: String,
    pub merchant: String,
    pub source_url: String,
    pub checkout_url: String,
    pub total_atomic: String,
    pub asset: String,
    pub in_stock: bool,
    pub rating: Option<f32>,
    pub evidence_note: String,
    pub crypto_payment_supported: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommerceState {
    AwaitingApproval,
    Authorized,
    InvoiceCreated,
    PaymentSubmitted,
    Completed,
    Rejected,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MerchantInvoice {
    pub provider: String,
    pub invoice_id: String,
    pub checkout_url: String,
    pub asset: String,
    pub amount_atomic: String,
    pub expires_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MerchantPaymentProof {
    pub invoice_id: String,
    pub transaction_hash: String,
    pub confirmed_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MerchantOrderReceipt {
    pub provider: String,
    pub order_id: String,
    pub receipt_url: String,
    pub status: String,
    pub verified_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CommerceAuditEvent {
    pub sequence: u32,
    pub event: String,
    pub detail: String,
    pub at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CommerceWorkflow {
    pub id: String,
    pub objective: String,
    pub state: CommerceState,
    pub selected_offer: ProductOffer,
    pub alternatives_considered: usize,
    pub budget_atomic: String,
    pub total_atomic: String,
    pub asset: String,
    pub approval_id: Option<String>,
    pub approved_at_ms: Option<u64>,
    #[serde(default)]
    pub merchant_invoice: Option<MerchantInvoice>,
    #[serde(default)]
    pub payment_proof: Option<MerchantPaymentProof>,
    #[serde(default)]
    pub order_receipt: Option<MerchantOrderReceipt>,
    pub audit_history: Vec<CommerceAuditEvent>,
}

#[derive(Debug, Error)]
pub enum CommerceTransitionError {
    #[error("commerce action conflicts with current state: {0}")]
    Conflict(String),
    #[error("invalid commerce action: {0}")]
    InvalidAction(String),
}

#[derive(Default)]
pub struct Commerce;

#[async_trait]
impl Bot for Commerce {
    fn descriptor(&self) -> BotDescriptor {
        BotDescriptor {
            id: "commerce",
            name: "Commerce",
            specialty: "Crypto-native merchant offer selection and approval",
            available: true,
        }
    }
    async fn execute(&self, task: &Task) -> Result<BotResult, BotError> {
        let input: CommerceInput = serde_json::from_value(task.input.clone()).map_err(|e| {
            BotError::InvalidInput(format!("Commerce requires structured crypto offers: {e}"))
        })?;
        let workflow = prepare_workflow(&input, &task.id.to_string())?;
        Ok(BotResult {
            summary: format!(
                "Commerce selected {} from {} for {} atomic units of {}. No payment or order has been executed.",
                workflow.selected_offer.name,
                workflow.selected_offer.merchant,
                workflow.total_atomic,
                workflow.asset
            ),
            data: json!({"workflow": workflow, "agent_version": AGENT_VERSION, "execution_available": false, "blocked_reason": "A verified crypto-accepting merchant adapter and Monad wallet signer are not configured."}),
        })
    }
}

pub fn prepare_workflow(
    input: &CommerceInput,
    task_id: &str,
) -> Result<CommerceWorkflow, BotError> {
    validate_input(input)?;
    let budget = parse_atomic(&input.budget_atomic, "budget_atomic")?;
    let selected = input
        .offers
        .iter()
        .filter(|o| {
            o.in_stock && o.crypto_payment_supported && o.asset.eq_ignore_ascii_case(&input.asset)
        })
        .filter_map(|o| {
            parse_atomic(&o.total_atomic, "total_atomic")
                .ok()
                .map(|total| (o, total))
        })
        .filter(|(_, total)| *total <= budget)
        .min_by_key(|(_, total)| *total)
        .map(|(o, _)| o.clone())
        .ok_or_else(|| {
            BotError::InvalidInput(
                "no in-stock, crypto-accepting offer fits the supplied asset and budget".into(),
            )
        })?;
    Ok(CommerceWorkflow {
        id: format!("commerce-{task_id}"),
        objective: input.objective.trim().to_owned(),
        state: CommerceState::AwaitingApproval,
        total_atomic: selected.total_atomic.clone(),
        asset: input.asset.trim().to_ascii_uppercase(),
        selected_offer: selected,
        alternatives_considered: input.offers.len(),
        budget_atomic: input.budget_atomic.clone(),
        approval_id: None,
        approved_at_ms: None,
        merchant_invoice: None,
        payment_proof: None,
        order_receipt: None,
        audit_history: vec![CommerceAuditEvent {
            sequence: 1,
            event: "offer_selected".into(),
            detail: "Eligible crypto offer selected; no transaction or merchant order was created."
                .into(),
            at_ms: unix_time_ms(),
        }],
    })
}

pub fn record_verified_invoice(
    workflow: &mut CommerceWorkflow,
    invoice: MerchantInvoice,
) -> Result<(), CommerceTransitionError> {
    require_state(workflow, CommerceState::Authorized)?;
    if invoice.provider.trim().is_empty() || invoice.invoice_id.trim().is_empty() {
        return Err(CommerceTransitionError::InvalidAction(
            "verified invoice requires a provider and invoice id".into(),
        ));
    }
    validate_url(&invoice.checkout_url, "invoice checkout URL")
        .map_err(|error| CommerceTransitionError::InvalidAction(error.to_string()))?;
    if !invoice.asset.eq_ignore_ascii_case(&workflow.asset)
        || invoice.amount_atomic != workflow.total_atomic
    {
        return Err(CommerceTransitionError::InvalidAction(
            "merchant invoice does not match the approved asset and amount".into(),
        ));
    }
    workflow.merchant_invoice = Some(invoice);
    workflow.state = CommerceState::InvoiceCreated;
    push_audit(
        workflow,
        "merchant_invoice_verified",
        "Merchant adapter created and read back an exact invoice.",
    );
    Ok(())
}

pub fn record_verified_payment(
    workflow: &mut CommerceWorkflow,
    proof: MerchantPaymentProof,
) -> Result<(), CommerceTransitionError> {
    require_state(workflow, CommerceState::InvoiceCreated)?;
    let invoice = workflow.merchant_invoice.as_ref().ok_or_else(|| {
        CommerceTransitionError::InvalidAction("merchant invoice is missing".into())
    })?;
    if proof.invoice_id != invoice.invoice_id
        || proof.transaction_hash.len() != 66
        || !proof.transaction_hash.starts_with("0x")
        || !proof.transaction_hash[2..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(CommerceTransitionError::InvalidAction(
            "payment proof must match the invoice and contain a transaction hash".into(),
        ));
    }
    workflow.payment_proof = Some(proof);
    workflow.state = CommerceState::PaymentSubmitted;
    push_audit(
        workflow,
        "merchant_payment_verified",
        "Merchant adapter and chain receipt agree that the invoice was paid.",
    );
    Ok(())
}

pub fn record_verified_order(
    workflow: &mut CommerceWorkflow,
    receipt: MerchantOrderReceipt,
) -> Result<(), CommerceTransitionError> {
    require_state(workflow, CommerceState::PaymentSubmitted)?;
    if receipt.provider.trim().is_empty() || receipt.order_id.trim().is_empty() {
        return Err(CommerceTransitionError::InvalidAction(
            "order receipt requires a provider and order id".into(),
        ));
    }
    validate_url(&receipt.receipt_url, "merchant receipt URL")
        .map_err(|error| CommerceTransitionError::InvalidAction(error.to_string()))?;
    if !matches!(receipt.status.as_str(), "confirmed" | "fulfilled") {
        return Err(CommerceTransitionError::InvalidAction(
            "merchant order is not confirmed or fulfilled".into(),
        ));
    }
    workflow.order_receipt = Some(receipt);
    workflow.state = CommerceState::Completed;
    push_audit(
        workflow,
        "merchant_order_verified",
        "Merchant order id and receipt were verified; purchase is complete.",
    );
    Ok(())
}

pub fn authorize(
    workflow: &mut CommerceWorkflow,
    approval_id: String,
    approved_total_atomic: &str,
) -> Result<(), CommerceTransitionError> {
    require_state(workflow, CommerceState::AwaitingApproval)?;
    if approved_total_atomic != workflow.total_atomic {
        return Err(CommerceTransitionError::InvalidAction(
            "approved total does not match the selected crypto amount".into(),
        ));
    }
    if approval_id.trim().is_empty() {
        return Err(CommerceTransitionError::InvalidAction(
            "approval id cannot be empty".into(),
        ));
    }
    workflow.approval_id = Some(approval_id);
    workflow.approved_at_ms = Some(unix_time_ms());
    workflow.state = CommerceState::Authorized;
    push_audit(
        workflow,
        "purchase_authorized",
        "User authorized the exact crypto offer. Execution remains blocked until a real wallet and merchant adapter are configured.",
    );
    Ok(())
}

pub fn reject(workflow: &mut CommerceWorkflow) -> Result<(), CommerceTransitionError> {
    require_state(workflow, CommerceState::AwaitingApproval)?;
    workflow.state = CommerceState::Rejected;
    push_audit(
        workflow,
        "purchase_rejected",
        "User rejected the proposal; no transaction was created.",
    );
    Ok(())
}

fn validate_input(input: &CommerceInput) -> Result<(), BotError> {
    if input.objective.trim().is_empty() || input.objective.len() > 2_000 {
        return Err(BotError::InvalidInput(
            "objective must contain between 1 and 2,000 characters".into(),
        ));
    }
    if input.asset.trim().is_empty() {
        return Err(BotError::InvalidInput("asset is required".into()));
    }
    parse_atomic(&input.budget_atomic, "budget_atomic")?;
    if input.offers.is_empty() || input.offers.len() > MAX_OFFERS {
        return Err(BotError::InvalidInput(format!(
            "offers must contain between 1 and {MAX_OFFERS} items"
        )));
    }
    for o in &input.offers {
        if o.id.trim().is_empty()
            || o.name.trim().is_empty()
            || o.merchant.trim().is_empty()
            || o.evidence_note.trim().is_empty()
            || o.asset.trim().is_empty()
        {
            return Err(BotError::InvalidInput(
                "every offer requires an id, name, merchant, asset, amount, and evidence note"
                    .into(),
            ));
        }
        parse_atomic(&o.total_atomic, "total_atomic")?;
        validate_url(&o.source_url, "source URL")?;
        validate_url(&o.checkout_url, "checkout URL")?;
        if o.rating.is_some_and(|r| !(0.0..=5.0).contains(&r)) {
            return Err(BotError::InvalidInput(
                "offer ratings must be between 0 and 5".into(),
            ));
        }
    }
    Ok(())
}

fn parse_atomic(value: &str, field: &str) -> Result<u128, BotError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 38 || !value.chars().all(|c| c.is_ascii_digit()) {
        return Err(BotError::InvalidInput(format!(
            "{field} must be a positive integer in atomic token units"
        )));
    }
    let parsed = value
        .parse::<u128>()
        .map_err(|_| BotError::InvalidInput(format!("{field} is too large")))?;
    if parsed == 0 {
        return Err(BotError::InvalidInput(format!(
            "{field} must be greater than zero"
        )));
    }
    Ok(parsed)
}

fn validate_url(raw: &str, field: &str) -> Result<(), BotError> {
    let url = Url::parse(raw)
        .map_err(|_| BotError::InvalidInput(format!("{field} must be a valid URL")))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
    {
        return Err(BotError::InvalidInput(format!(
            "{field} must use HTTP(S), include a host, and contain no credentials"
        )));
    }
    Ok(())
}

fn require_state(
    workflow: &CommerceWorkflow,
    expected: CommerceState,
) -> Result<(), CommerceTransitionError> {
    if workflow.state != expected {
        return Err(CommerceTransitionError::Conflict(format!(
            "expected {expected:?}, found {:?}",
            workflow.state
        )));
    }
    Ok(())
}
fn push_audit(workflow: &mut CommerceWorkflow, event: &str, detail: &str) {
    workflow.audit_history.push(CommerceAuditEvent {
        sequence: u32::try_from(workflow.audit_history.len() + 1).unwrap_or(u32::MAX),
        event: event.into(),
        detail: detail.into(),
        at_ms: unix_time_ms(),
    });
}
fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::{
        Commerce, CommerceState, MerchantInvoice, MerchantOrderReceipt, MerchantPaymentProof,
        authorize, record_verified_invoice, record_verified_order, record_verified_payment,
    };
    use donads_core::{Bot, Task, TaskInput};
    use serde_json::json;
    fn task() -> Task {
        Task::queued(
            TaskInput {
                prompt: "Buy with MON".into(),
                bot: Some("commerce".into()),
                input: json!({"objective":"Buy a keyboard with MON","budget_atomic":"3000000000000000000","asset":"MON","offers":[{"id":"a","name":"Keyboard","merchant":"Crypto Store","source_url":"https://shop.example/a","checkout_url":"https://shop.example/a/checkout","total_atomic":"2500000000000000000","asset":"MON","in_stock":true,"rating":4.5,"evidence_note":"Merchant states native MON checkout.","crypto_payment_supported":true}]}),
            },
            "commerce".into(),
        )
    }
    #[tokio::test]
    async fn prepares_intent_without_claiming_execution() {
        let result = Commerce.execute(&task()).await.expect("intent");
        assert_eq!(result.data["execution_available"], false);
    }
    #[tokio::test]
    async fn approval_binds_exact_amount() {
        let result = Commerce.execute(&task()).await.expect("intent");
        let mut workflow =
            serde_json::from_value(result.data["workflow"].clone()).expect("workflow");
        assert!(authorize(&mut workflow, "approval-1".into(), "1").is_err());
        authorize(&mut workflow, "approval-1".into(), "2500000000000000000").expect("approval");
        assert_eq!(workflow.state, CommerceState::Authorized);
    }

    #[tokio::test]
    async fn completion_requires_matching_invoice_payment_and_order_receipt() {
        let result = Commerce.execute(&task()).await.expect("intent");
        let mut workflow =
            serde_json::from_value(result.data["workflow"].clone()).expect("workflow");
        authorize(&mut workflow, "approval-1".into(), "2500000000000000000").expect("approval");
        record_verified_invoice(
            &mut workflow,
            MerchantInvoice {
                provider: "merchant-api".into(),
                invoice_id: "invoice-1".into(),
                checkout_url: "https://shop.example/invoices/1".into(),
                asset: "MON".into(),
                amount_atomic: "2500000000000000000".into(),
                expires_at_ms: None,
            },
        )
        .expect("invoice");
        assert!(
            record_verified_payment(
                &mut workflow,
                MerchantPaymentProof {
                    invoice_id: "wrong".into(),
                    transaction_hash: format!("0x{}", "1".repeat(64)),
                    confirmed_at_ms: 1,
                },
            )
            .is_err()
        );
        record_verified_payment(
            &mut workflow,
            MerchantPaymentProof {
                invoice_id: "invoice-1".into(),
                transaction_hash: format!("0x{}", "1".repeat(64)),
                confirmed_at_ms: 1,
            },
        )
        .expect("payment");
        record_verified_order(
            &mut workflow,
            MerchantOrderReceipt {
                provider: "merchant-api".into(),
                order_id: "order-1".into(),
                receipt_url: "https://shop.example/orders/1".into(),
                status: "confirmed".into(),
                verified_at_ms: 2,
            },
        )
        .expect("order");
        assert_eq!(workflow.state, CommerceState::Completed);
    }
}
