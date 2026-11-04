//! Initial Sentinel bytecode analyzer.

use async_trait::async_trait;
use donads_core::{Bot, BotDescriptor, BotError, BotResult, Task};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// Read-only threat scanner used by the first DONADS milestone.
#[derive(Default)]
pub struct Sentinel;

/// Exact transfer facts checked before Flow may authorize or record execution.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NativeTransferPolicyRequest {
    pub chain_id: u64,
    pub sender: String,
    pub recipient: String,
    pub asset: String,
    pub approved_amount_wei: u128,
    pub requested_amount_wei: u128,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct PolicyDecision {
    pub allowed: bool,
    pub checks: Vec<&'static str>,
}

/// Mandatory deterministic policy gate for the first native-MON execution path.
pub struct SentinelPolicyGuard;

impl SentinelPolicyGuard {
    pub fn validate_native_transfer(
        request: &NativeTransferPolicyRequest,
    ) -> Result<PolicyDecision, BotError> {
        if request.chain_id != 10_143 {
            return Err(BotError::InvalidInput(
                "Sentinel rejected execution outside Monad Testnet".into(),
            ));
        }
        validate_address(&request.sender, "sender")?;
        validate_address(&request.recipient, "recipient")?;
        if request.sender.eq_ignore_ascii_case(&request.recipient) {
            return Err(BotError::InvalidInput(
                "Sentinel rejected a self-transfer".into(),
            ));
        }
        if !request.asset.eq_ignore_ascii_case("MON") {
            return Err(BotError::InvalidInput(
                "Sentinel permits native MON only in the first execution path".into(),
            ));
        }
        if request.requested_amount_wei == 0
            || request.requested_amount_wei != request.approved_amount_wei
        {
            return Err(BotError::InvalidInput(
                "Sentinel rejected an amount that differs from the approved intent".into(),
            ));
        }
        Ok(PolicyDecision {
            allowed: true,
            checks: vec![
                "monad_testnet",
                "valid_sender",
                "valid_recipient",
                "native_mon",
                "exact_approved_amount",
            ],
        })
    }
}

#[derive(Debug, Serialize)]
struct Finding {
    id: &'static str,
    severity: &'static str,
    title: &'static str,
    evidence: String,
}

#[async_trait]
impl Bot for Sentinel {
    fn descriptor(&self) -> BotDescriptor {
        BotDescriptor {
            id: "sentinel",
            name: "Sentinel",
            specialty: "EVM bytecode threat detection",
            available: true,
        }
    }

    async fn execute(&self, task: &Task) -> Result<BotResult, BotError> {
        let raw = task.input["bytecode"]
            .as_str()
            .ok_or_else(|| BotError::InvalidInput("input.bytecode must be a hex string".into()))?;
        let normalized = raw.strip_prefix("0x").unwrap_or(raw);
        let bytecode = hex::decode(normalized)
            .map_err(|error| BotError::InvalidInput(format!("invalid bytecode hex: {error}")))?;
        if bytecode.is_empty() {
            return Err(BotError::InvalidInput("bytecode cannot be empty".into()));
        }

        let mut findings = Vec::new();
        add_opcode_finding(
            &mut findings,
            &bytecode,
            0xff,
            "SELFDESTRUCT_REACHABLE",
            "critical",
            "Contract contains SELFDESTRUCT",
        );
        add_opcode_finding(
            &mut findings,
            &bytecode,
            0xf4,
            "DELEGATECALL_PRESENT",
            "high",
            "Contract contains DELEGATECALL",
        );
        add_opcode_finding(
            &mut findings,
            &bytecode,
            0xf2,
            "CALLCODE_PRESENT",
            "high",
            "Contract contains deprecated CALLCODE",
        );

        let score = findings.iter().fold(0_u8, |score, finding| {
            score.saturating_add(match finding.severity {
                "critical" => 60,
                "high" => 30,
                _ => 10,
            })
        });
        let score = score.min(100);
        let summary = if findings.is_empty() {
            "No high-confidence dangerous opcodes were found. This is not a full audit.".into()
        } else {
            format!(
                "Sentinel found {} high-confidence risk signal(s); threat score {score}/100.",
                findings.len()
            )
        };

        Ok(BotResult {
            summary,
            data: json!({
                "threat_score": score,
                "findings": findings,
                "bytecode_bytes": bytecode.len(),
                "scope": "opcode-presence-v1",
                "disclaimer": "Opcode presence is a triage signal, not proof of exploitability."
            }),
        })
    }
}

fn add_opcode_finding(
    findings: &mut Vec<Finding>,
    bytecode: &[u8],
    opcode: u8,
    id: &'static str,
    severity: &'static str,
    title: &'static str,
) {
    if let Some(offset) = find_executable_opcode(bytecode, opcode) {
        findings.push(Finding {
            id,
            severity,
            title,
            evidence: format!("opcode 0x{opcode:02x} at byte offset {offset}"),
        });
    }
}

fn find_executable_opcode(bytecode: &[u8], target: u8) -> Option<usize> {
    let mut offset = 0;
    while offset < bytecode.len() {
        let opcode = bytecode[offset];
        if opcode == target {
            return Some(offset);
        }
        let operand_bytes = if (0x60..=0x7f).contains(&opcode) {
            usize::from(opcode - 0x5f)
        } else {
            0
        };
        offset = offset.saturating_add(1 + operand_bytes);
    }
    None
}

fn validate_address(address: &str, label: &str) -> Result<(), BotError> {
    let bytes = address.strip_prefix("0x").ok_or_else(|| {
        BotError::InvalidInput(format!("Sentinel requires a 0x-prefixed {label} address"))
    })?;
    if bytes.len() != 40 || !bytes.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err(BotError::InvalidInput(format!(
            "Sentinel requires a 20-byte hexadecimal {label} address"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use donads_core::{Bot, Task, TaskInput};
    use serde_json::json;

    use super::{NativeTransferPolicyRequest, Sentinel, SentinelPolicyGuard};

    #[tokio::test]
    async fn reports_selfdestruct() {
        let task = Task::queued(
            TaskInput {
                prompt: "scan".into(),
                bot: Some("sentinel".into()),
                input: json!({"bytecode": "0x6000ff"}),
            },
            "sentinel".into(),
        );
        let result = Sentinel
            .execute(&task)
            .await
            .expect("analysis should succeed");
        assert_eq!(result.data["threat_score"], 60);
        assert_eq!(result.data["findings"][0]["id"], "SELFDESTRUCT_REACHABLE");
    }

    #[tokio::test]
    async fn rejects_empty_bytecode() {
        let task = Task::queued(
            TaskInput {
                prompt: "scan".into(),
                bot: None,
                input: json!({"bytecode": "0x"}),
            },
            "sentinel".into(),
        );
        assert!(Sentinel.execute(&task).await.is_err());
    }

    #[tokio::test]
    async fn ignores_dangerous_bytes_inside_push_operands() {
        let task = Task::queued(
            TaskInput {
                prompt: "scan".into(),
                bot: Some("sentinel".into()),
                input: json!({"bytecode": "0x60ff61f4f200"}),
            },
            "sentinel".into(),
        );
        let result = Sentinel
            .execute(&task)
            .await
            .expect("analysis should succeed");
        assert_eq!(result.data["threat_score"], 0);
        assert_eq!(result.data["findings"], json!([]));
    }

    #[tokio::test]
    async fn handles_truncated_push_data_without_panicking() {
        let task = Task::queued(
            TaskInput {
                prompt: "scan".into(),
                bot: Some("sentinel".into()),
                input: json!({"bytecode": "0x7fff"}),
            },
            "sentinel".into(),
        );
        let result = Sentinel
            .execute(&task)
            .await
            .expect("analysis should succeed");
        assert_eq!(result.data["threat_score"], 0);
    }

    #[test]
    fn policy_guard_accepts_only_exact_testnet_mon_transfers() {
        let request = NativeTransferPolicyRequest {
            chain_id: 10_143,
            sender: "0x1111111111111111111111111111111111111111".into(),
            recipient: "0x2222222222222222222222222222222222222222".into(),
            asset: "MON".into(),
            approved_amount_wei: 1_000,
            requested_amount_wei: 1_000,
        };
        assert!(SentinelPolicyGuard::validate_native_transfer(&request).is_ok());
        let mut changed = request;
        changed.requested_amount_wei = 999;
        assert!(SentinelPolicyGuard::validate_native_transfer(&changed).is_err());
    }
}
