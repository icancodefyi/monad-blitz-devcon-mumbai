//! Real dispatcher acceptance flow using an ephemeral, unfunded wallet.
//! The key exists only in this process and signs a login message, never a transaction.

use std::time::Duration;

use anyhow::{Context, anyhow};
use k256::{ecdsa::SigningKey, elliptic_curve::Generate};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let base_url = std::env::var("DONADS_ACCEPTANCE_API_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8080".into());
    let client = Client::builder().timeout(Duration::from_secs(5)).build()?;
    let signing_key = SigningKey::generate();
    let encoded = signing_key.verifying_key().to_sec1_point(false);
    let public_hash = Keccak256::digest(&encoded.as_bytes()[1..]);
    let address = format!("0x{}", hex::encode(&public_hash[12..]));

    let challenge = response_json(
        client
            .post(format!("{base_url}/v1/auth/challenge"))
            .json(&json!({"address": address}))
            .send()
            .await?,
    )
    .await?;
    let message = challenge["message"]
        .as_str()
        .ok_or_else(|| anyhow!("challenge response did not contain a message"))?;
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    let digest = Keccak256::new()
        .chain_update(prefix.as_bytes())
        .chain_update(message.as_bytes())
        .finalize();
    let (signature, recovery_id) = signing_key.sign_prehash_recoverable(digest.as_ref());
    let mut signature_bytes = signature.to_bytes().to_vec();
    signature_bytes.push(recovery_id.to_byte() + 27);

    let session = response_json(
        client
            .post(format!("{base_url}/v1/auth/verify"))
            .json(&json!({
                "address": address,
                "signature": format!("0x{}", hex::encode(signature_bytes))
            }))
            .send()
            .await?,
    )
    .await?;
    let token = session["access_token"]
        .as_str()
        .ok_or_else(|| anyhow!("session response did not contain a token"))?;

    let created = response_json(
        client
            .post(format!("{base_url}/v1/tasks"))
            .bearer_auth(token)
            .json(&json!({
                "prompt": "Acceptance test: detect executable SELFDESTRUCT",
                "bot": "sentinel",
                "input": {"bytecode": "0x6000ff"}
            }))
            .send()
            .await?,
    )
    .await?;
    let task_id = created["id"]
        .as_str()
        .ok_or_else(|| anyhow!("task response did not contain an id"))?;

    let mut task = Value::Null;
    for _ in 0..50 {
        task = response_json(
            client
                .get(format!("{base_url}/v1/tasks/{task_id}"))
                .bearer_auth(token)
                .send()
                .await?,
        )
        .await?;
        if matches!(
            task["status"]["state"].as_str(),
            Some("completed" | "failed")
        ) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if task["status"]["state"] != "completed" {
        return Err(anyhow!(
            "task did not complete successfully: {}",
            task["status"]
        ));
    }
    if task["status"]["data"]["findings"][0]["id"] != "SELFDESTRUCT_REACHABLE" {
        return Err(anyhow!("Sentinel did not return the expected finding"));
    }

    let history = response_json(
        client
            .get(format!("{base_url}/v1/tasks?limit=20"))
            .bearer_auth(token)
            .send()
            .await?,
    )
    .await?;
    let history_contains_task = history
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item["id"] == task_id));
    if !history_contains_task {
        return Err(anyhow!("completed task was missing from wallet history"));
    }

    let logout = client
        .post(format!("{base_url}/v1/auth/logout"))
        .bearer_auth(token)
        .send()
        .await?;
    if logout.status() != StatusCode::NO_CONTENT {
        return Err(anyhow!("logout returned {}", logout.status()));
    }
    let revoked = client
        .get(format!("{base_url}/v1/tasks/{task_id}"))
        .bearer_auth(token)
        .send()
        .await?;
    if revoked.status() != StatusCode::UNAUTHORIZED {
        return Err(anyhow!("revoked session returned {}", revoked.status()));
    }

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "wallet": address,
            "task_id": task_id,
            "state": task["status"]["state"],
            "summary": task["status"]["summary"],
            "threat_score": task["status"]["data"]["threat_score"],
            "finding": task["status"]["data"]["findings"][0]["id"],
            "history_contains_task": history_contains_task,
            "logout_status": 204,
            "revoked_session_status": 401
        }))?
    );
    Ok(())
}

async fn response_json(response: reqwest::Response) -> anyhow::Result<Value> {
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        return Err(anyhow!("API returned {status}: {body}"));
    }
    serde_json::from_str(&body).context("API returned invalid JSON")
}
