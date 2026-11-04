use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;

/// Supported Monad deployment networks.
#[derive(Clone, Copy, Debug, Serialize)]
pub enum Network {
    /// Monad's public development network.
    Testnet,
    /// Monad's production network.
    Mainnet,
}

impl Network {
    /// Returns the EIP-155 chain identifier.
    #[must_use]
    pub const fn chain_id(self) -> u64 {
        match self {
            Self::Testnet => 10_143,
            Self::Mainnet => 143,
        }
    }
}

/// Live RPC status returned by the health endpoint.
#[derive(Clone, Debug, Serialize)]
pub struct NetworkStatus {
    /// Configured network.
    pub network: Network,
    /// Expected EIP-155 chain identifier.
    pub chain_id: u64,
    /// Latest block reported by the RPC.
    pub block_number: u64,
}

/// A mined native-token transaction verified against the configured Monad RPC.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct ConfirmedNativeTransfer {
    pub transaction_hash: String,
    pub from: String,
    pub to: String,
    pub value_wei: String,
    pub block_number: u64,
}

#[derive(Debug, Deserialize)]
struct RpcTransaction {
    hash: String,
    from: String,
    to: Option<String>,
    value: String,
    #[serde(rename = "blockNumber")]
    block_number: Option<String>,
    input: String,
}

#[derive(Debug, Deserialize)]
struct RpcReceipt {
    #[serde(rename = "transactionHash")]
    transaction_hash: String,
    #[serde(rename = "blockNumber")]
    block_number: String,
    status: String,
}

/// Errors returned by the Monad JSON-RPC adapter.
#[derive(Debug, Error)]
pub enum ChainError {
    /// RPC transport or protocol failure.
    #[error("Monad RPC request failed: {0}")]
    Rpc(#[from] reqwest::Error),
    /// RPC returned malformed or unexpected data.
    #[error("Monad RPC returned invalid data: {0}")]
    InvalidResponse(String),
}

/// Minimal read-only Monad JSON-RPC client used during the MVP.
#[derive(Clone)]
pub struct ChainClient {
    client: Client,
    rpc_url: String,
    network: Network,
}

impl ChainClient {
    /// Creates a client with a strict request timeout.
    ///
    /// # Errors
    ///
    /// Returns [`ChainError::Rpc`] if the HTTP client cannot be constructed.
    pub fn new(rpc_url: String, network: Network) -> Result<Self, ChainError> {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()?;
        Ok(Self {
            client,
            rpc_url,
            network,
        })
    }

    /// Queries the latest block and verifies the configured chain ID.
    ///
    /// # Errors
    ///
    /// Returns an error if the RPC is unavailable, returns malformed data, or
    /// reports a chain ID different from the configured network.
    pub async fn status(&self) -> Result<NetworkStatus, ChainError> {
        let chain_id = self.rpc_hex("eth_chainId").await?;
        if chain_id != self.network.chain_id() {
            return Err(ChainError::InvalidResponse(format!(
                "expected chain {}, received {chain_id}",
                self.network.chain_id()
            )));
        }
        let block_number = self.rpc_hex("eth_blockNumber").await?;
        Ok(NetworkStatus {
            network: self.network,
            chain_id,
            block_number,
        })
    }

    /// Verifies that a transaction is mined successfully and is a plain native
    /// MON transfer. Recipient and amount binding is enforced by the caller.
    pub async fn confirmed_native_transfer(
        &self,
        transaction_hash: &str,
    ) -> Result<ConfirmedNativeTransfer, ChainError> {
        validate_transaction_hash(transaction_hash)?;
        // Never trust transaction data until this exact RPC endpoint has proven
        // that it is serving the configured Monad network.
        self.status().await?;
        let transaction: Option<RpcTransaction> = self
            .rpc("eth_getTransactionByHash", json!([transaction_hash]))
            .await?;
        let transaction = transaction.ok_or_else(|| {
            ChainError::InvalidResponse("transaction is not known by the configured RPC".into())
        })?;
        let receipt: Option<RpcReceipt> = self
            .rpc("eth_getTransactionReceipt", json!([transaction_hash]))
            .await?;
        let receipt = receipt.ok_or_else(|| {
            ChainError::InvalidResponse("transaction has not been mined yet".into())
        })?;
        if receipt.status != "0x1" {
            return Err(ChainError::InvalidResponse(
                "transaction receipt reports failure".into(),
            ));
        }
        if !receipt
            .transaction_hash
            .eq_ignore_ascii_case(&transaction.hash)
        {
            return Err(ChainError::InvalidResponse(
                "transaction and receipt hashes do not match".into(),
            ));
        }
        let transaction_block = transaction.block_number.as_deref().ok_or_else(|| {
            ChainError::InvalidResponse("transaction is not assigned to a block".into())
        })?;
        if !transaction_block.eq_ignore_ascii_case(&receipt.block_number) {
            return Err(ChainError::InvalidResponse(
                "transaction and receipt blocks do not match".into(),
            ));
        }
        if transaction.input != "0x" && transaction.input != "0x0" {
            return Err(ChainError::InvalidResponse(
                "transaction contains calldata and is not a plain MON transfer".into(),
            ));
        }
        let to = transaction.to.ok_or_else(|| {
            ChainError::InvalidResponse("contract creation is not a native transfer".into())
        })?;
        let value_wei = parse_hex_u128(&transaction.value)?.to_string();
        Ok(ConfirmedNativeTransfer {
            transaction_hash: transaction.hash,
            from: transaction.from,
            to,
            value_wei,
            block_number: parse_hex_u64(&receipt.block_number)?,
        })
    }

    async fn rpc<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T, ChainError> {
        let response: serde_json::Value = self
            .client
            .post(&self.rpc_url)
            .json(&json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if !response["error"].is_null() {
            return Err(ChainError::InvalidResponse(response["error"].to_string()));
        }
        serde_json::from_value(response["result"].clone())
            .map_err(|error| ChainError::InvalidResponse(error.to_string()))
    }

    async fn rpc_hex(&self, method: &str) -> Result<u64, ChainError> {
        let response: serde_json::Value = self
            .client
            .post(&self.rpc_url)
            .json(&json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": []}))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let value = response["result"]
            .as_str()
            .ok_or_else(|| ChainError::InvalidResponse(response.to_string()))?;
        u64::from_str_radix(value.trim_start_matches("0x"), 16)
            .map_err(|error| ChainError::InvalidResponse(error.to_string()))
    }
}

fn validate_transaction_hash(value: &str) -> Result<(), ChainError> {
    if value.len() != 66
        || !value.starts_with("0x")
        || !value[2..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err(ChainError::InvalidResponse(
            "transaction hash must contain 32 hexadecimal bytes".into(),
        ));
    }
    Ok(())
}

fn parse_hex_u64(value: &str) -> Result<u64, ChainError> {
    u64::from_str_radix(value.trim_start_matches("0x"), 16)
        .map_err(|error| ChainError::InvalidResponse(error.to_string()))
}

fn parse_hex_u128(value: &str) -> Result<u128, ChainError> {
    u128::from_str_radix(value.trim_start_matches("0x"), 16)
        .map_err(|error| ChainError::InvalidResponse(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{ChainClient, Network, parse_hex_u128, validate_transaction_hash};

    #[test]
    fn validates_hashes_and_exact_values() {
        assert!(validate_transaction_hash(&format!("0x{}", "ab".repeat(32))).is_ok());
        assert!(validate_transaction_hash("0x12").is_err());
        assert_eq!(
            parse_hex_u128("0x1158e460913d0000").expect("value"),
            1_250_000_000_000_000_000
        );
    }

    #[tokio::test]
    #[ignore = "requires public Monad testnet access"]
    async fn reaches_monad_testnet() {
        let client = ChainClient::new("https://testnet-rpc.monad.xyz".into(), Network::Testnet)
            .expect("client should be constructed");
        let status = client
            .status()
            .await
            .expect("Monad testnet should be reachable");
        assert_eq!(status.chain_id, 10_143);
        assert!(status.block_number > 0);
    }
}
