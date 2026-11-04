use std::{collections::HashMap, sync::Arc};

use axum::{
    Json,
    body::Body,
    extract::State,
    http::{Request, StatusCode, header::AUTHORIZATION},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sha3::{Digest, Keccak256};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::RwLock;
use uuid::Uuid;

const CHALLENGE_LIFETIME: Duration = Duration::minutes(5);
const SESSION_LIFETIME: Duration = Duration::hours(12);
const RATE_WINDOW: Duration = Duration::minutes(1);
const MAX_CHALLENGES_PER_WALLET_PER_MINUTE: u32 = 5;
const MAX_PENDING_CHALLENGES: usize = 10_000;
const MAX_ACTIVE_SESSIONS: usize = 100_000;

#[derive(Clone, Debug)]
pub struct AuthPrincipal {
    pub owner_id: String,
    pub session_token: String,
}

#[derive(Clone)]
pub struct AuthService {
    challenges: Arc<RwLock<HashMap<String, PendingChallenge>>>,
    challenge_attempts: Arc<RwLock<HashMap<String, RateWindow>>>,
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    domain: Arc<str>,
    uri: Arc<str>,
    chain_id: u64,
    session_requests_per_minute: u32,
}

#[derive(Clone, Debug)]
struct PendingChallenge {
    message: String,
    expires_at: OffsetDateTime,
}

#[derive(Clone, Debug)]
struct Session {
    owner_id: String,
    expires_at: OffsetDateTime,
    rate_window: RateWindow,
}

#[derive(Clone, Debug)]
struct RateWindow {
    started_at: OffsetDateTime,
    requests: u32,
}

#[derive(Debug, Deserialize)]
pub struct ChallengeInput {
    pub address: String,
}

#[derive(Debug, Serialize)]
pub struct ChallengeOutput {
    pub address: String,
    pub message: String,
    pub expires_at: String,
}

#[derive(Debug, Deserialize)]
pub struct VerifyInput {
    pub address: String,
    pub signature: String,
}

#[derive(Debug, Serialize)]
pub struct SessionOutput {
    pub access_token: String,
    pub token_type: &'static str,
    pub expires_at: String,
    pub owner_id: String,
}

#[derive(Debug)]
pub struct AuthError {
    status: StatusCode,
    message: &'static str,
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for AuthError {}

impl AuthError {
    fn bad_request(message: &'static str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message,
        }
    }

    fn unauthorized(message: &'static str) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message,
        }
    }

    fn too_many_requests(message: &'static str) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            message,
        }
    }
}

impl IntoResponse for AuthError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({"error": self.message})),
        )
            .into_response()
    }
}

impl AuthService {
    pub fn new(
        domain: String,
        uri: String,
        chain_id: u64,
        session_requests_per_minute: u32,
    ) -> Result<Self, AuthError> {
        if domain.trim().is_empty() || domain.contains(['\n', '\r']) {
            return Err(AuthError::bad_request("authentication domain is invalid"));
        }
        let parsed_uri = reqwest::Url::parse(&uri)
            .map_err(|_| AuthError::bad_request("authentication URI is invalid"))?;
        if !matches!(parsed_uri.scheme(), "http" | "https") || parsed_uri.host_str().is_none() {
            return Err(AuthError::bad_request(
                "authentication URI must use HTTP(S)",
            ));
        }
        if session_requests_per_minute == 0 {
            return Err(AuthError::bad_request(
                "session rate limit must be greater than zero",
            ));
        }
        Ok(Self {
            challenges: Arc::new(RwLock::new(HashMap::new())),
            challenge_attempts: Arc::new(RwLock::new(HashMap::new())),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            domain: domain.into(),
            uri: uri.into(),
            chain_id,
            session_requests_per_minute,
        })
    }

    pub async fn create_challenge(&self, raw_address: &str) -> Result<ChallengeOutput, AuthError> {
        let address = normalize_address(raw_address)?;
        let now = OffsetDateTime::now_utc();
        let mut challenge_attempts = self.challenge_attempts.write().await;
        if challenge_attempts.len() >= MAX_PENDING_CHALLENGES {
            challenge_attempts.retain(|_, window| now - window.started_at < RATE_WINDOW);
        }
        if challenge_attempts.len() >= MAX_PENDING_CHALLENGES
            && !challenge_attempts.contains_key(&address)
        {
            return Err(AuthError::too_many_requests(
                "sign-in challenge capacity reached; retry in one minute",
            ));
        }
        enforce_rate_limit(
            &mut challenge_attempts,
            &address,
            now,
            MAX_CHALLENGES_PER_WALLET_PER_MINUTE,
            "too many sign-in challenges for this wallet",
        )?;
        drop(challenge_attempts);
        let expires_at = now + CHALLENGE_LIFETIME;
        let nonce = Uuid::new_v4().simple().to_string();
        let issued = now
            .format(&Rfc3339)
            .map_err(|_| AuthError::bad_request("could not format challenge time"))?;
        let expires = expires_at
            .format(&Rfc3339)
            .map_err(|_| AuthError::bad_request("could not format challenge expiry"))?;
        let message = format!(
            "{} wants you to sign in with your Ethereum account:\n{}\n\nSign in to DONADS. This request does not authorize a transaction.\n\nURI: {}\nVersion: 1\nChain ID: {}\nNonce: {}\nIssued At: {}\nExpiration Time: {}",
            self.domain, address, self.uri, self.chain_id, nonce, issued, expires
        );
        let mut challenges = self.challenges.write().await;
        if challenges.len() >= MAX_PENDING_CHALLENGES {
            challenges.retain(|_, challenge| challenge.expires_at > now);
        }
        if challenges.len() >= MAX_PENDING_CHALLENGES && !challenges.contains_key(&address) {
            return Err(AuthError::too_many_requests(
                "sign-in challenge capacity reached; retry shortly",
            ));
        }
        challenges.insert(
            address.clone(),
            PendingChallenge {
                message: message.clone(),
                expires_at,
            },
        );
        Ok(ChallengeOutput {
            address,
            message,
            expires_at: expires,
        })
    }

    pub async fn verify(&self, input: VerifyInput) -> Result<SessionOutput, AuthError> {
        let address = normalize_address(&input.address)?;
        let challenge = self
            .challenges
            .write()
            .await
            .remove(&address)
            .ok_or_else(|| AuthError::unauthorized("challenge is missing or already used"))?;
        if challenge.expires_at <= OffsetDateTime::now_utc() {
            return Err(AuthError::unauthorized("challenge has expired"));
        }
        let recovered = recover_address(&challenge.message, &input.signature)?;
        if recovered != address {
            return Err(AuthError::unauthorized(
                "wallet signature does not match the requested address",
            ));
        }

        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let expires_at = OffsetDateTime::now_utc() + SESSION_LIFETIME;
        let mut sessions = self.sessions.write().await;
        sessions.retain(|_, session| session.expires_at > OffsetDateTime::now_utc());
        sessions.retain(|_, session| session.owner_id != address);
        if sessions.len() >= MAX_ACTIVE_SESSIONS {
            return Err(AuthError::too_many_requests(
                "session capacity reached; retry shortly",
            ));
        }
        sessions.insert(
            token.clone(),
            Session {
                owner_id: address.clone(),
                expires_at,
                rate_window: RateWindow {
                    started_at: OffsetDateTime::now_utc(),
                    requests: 0,
                },
            },
        );
        Ok(SessionOutput {
            access_token: token,
            token_type: "Bearer",
            expires_at: expires_at
                .format(&Rfc3339)
                .map_err(|_| AuthError::bad_request("could not format session expiry"))?,
            owner_id: address,
        })
    }

    async fn authenticate(&self, token: &str) -> Result<AuthPrincipal, AuthError> {
        let now = OffsetDateTime::now_utc();
        let mut sessions = self.sessions.write().await;
        let session = sessions
            .get_mut(token)
            .ok_or_else(|| AuthError::unauthorized("session is invalid"))?;
        if session.expires_at <= now {
            sessions.remove(token);
            return Err(AuthError::unauthorized("session has expired"));
        }
        if now - session.rate_window.started_at >= RATE_WINDOW {
            session.rate_window = RateWindow {
                started_at: now,
                requests: 0,
            };
        }
        if session.rate_window.requests >= self.session_requests_per_minute {
            return Err(AuthError::too_many_requests(
                "session request limit exceeded; retry in one minute",
            ));
        }
        session.rate_window.requests += 1;
        Ok(AuthPrincipal {
            owner_id: session.owner_id.clone(),
            session_token: token.to_owned(),
        })
    }

    pub async fn revoke(&self, token: &str) {
        self.sessions.write().await.remove(token);
    }
}

fn enforce_rate_limit(
    windows: &mut HashMap<String, RateWindow>,
    key: &str,
    now: OffsetDateTime,
    limit: u32,
    message: &'static str,
) -> Result<(), AuthError> {
    let window = windows.entry(key.to_owned()).or_insert(RateWindow {
        started_at: now,
        requests: 0,
    });
    if now - window.started_at >= RATE_WINDOW {
        *window = RateWindow {
            started_at: now,
            requests: 0,
        };
    }
    if window.requests >= limit {
        return Err(AuthError::too_many_requests(message));
    }
    window.requests += 1;
    Ok(())
}

pub async fn require_auth(
    State(auth): State<AuthService>,
    mut request: Request<Body>,
    next: Next,
) -> Result<Response, AuthError> {
    let value = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AuthError::unauthorized("Authorization bearer token is required"))?;
    let token = value
        .strip_prefix("Bearer ")
        .filter(|token| token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| AuthError::unauthorized("Authorization bearer token is invalid"))?;
    let principal = auth.authenticate(token).await?;
    request.extensions_mut().insert(principal);
    Ok(next.run(request).await)
}

fn normalize_address(value: &str) -> Result<String, AuthError> {
    let value = value.trim();
    let bytes = value
        .strip_prefix("0x")
        .filter(|hex| hex.len() == 40 && hex.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| AuthError::bad_request("wallet address is invalid"))?;
    Ok(format!("0x{}", bytes.to_ascii_lowercase()))
}

fn recover_address(message: &str, raw_signature: &str) -> Result<String, AuthError> {
    use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};

    let bytes = hex::decode(raw_signature.trim().strip_prefix("0x").unwrap_or(""))
        .map_err(|_| AuthError::unauthorized("wallet signature is invalid"))?;
    if bytes.len() != 65 {
        return Err(AuthError::unauthorized("wallet signature is invalid"));
    }
    let signature = Signature::from_slice(&bytes[..64])
        .map_err(|_| AuthError::unauthorized("wallet signature is invalid"))?;
    if signature != signature.normalize_s() {
        return Err(AuthError::unauthorized("wallet signature is non-canonical"));
    }
    let recovery_byte = match bytes[64] {
        0 | 1 => bytes[64],
        27 | 28 => bytes[64] - 27,
        _ => return Err(AuthError::unauthorized("wallet recovery id is invalid")),
    };
    let recovery_id = RecoveryId::try_from(recovery_byte)
        .map_err(|_| AuthError::unauthorized("wallet recovery id is invalid"))?;
    let prefix = format!("\x19Ethereum Signed Message:\n{}", message.len());
    let hash = Keccak256::new()
        .chain_update(prefix.as_bytes())
        .chain_update(message.as_bytes())
        .finalize();
    let key = VerifyingKey::recover_from_prehash(hash.as_ref(), &signature, recovery_id)
        .map_err(|_| AuthError::unauthorized("wallet signature could not be recovered"))?;
    let encoded = key.to_sec1_point(false);
    let digest = Keccak256::digest(&encoded.as_bytes()[1..]);
    Ok(format!("0x{}", hex::encode(&digest[12..])))
}

#[cfg(test)]
mod tests {
    use k256::ecdsa::SigningKey;
    use sha3::{Digest, Keccak256};
    use time::{Duration, OffsetDateTime};

    use super::{AuthService, RateWindow, Session, VerifyInput};

    #[tokio::test]
    async fn challenge_is_chain_bound_short_lived_and_replaced_per_address() {
        let auth = AuthService::new(
            "localhost:3000".into(),
            "http://localhost:3000".into(),
            10_143,
            120,
        )
        .expect("auth config");
        let first = auth
            .create_challenge("0x1111111111111111111111111111111111111111")
            .await
            .expect("challenge");
        let second = auth
            .create_challenge("0x1111111111111111111111111111111111111111")
            .await
            .expect("replacement");
        assert!(first.message.contains("Chain ID: 10143"));
        assert!(first.message.contains("does not authorize a transaction"));
        assert_ne!(first.message, second.message);
    }

    #[tokio::test]
    async fn valid_personal_signature_creates_a_single_wallet_session() {
        let signing_key = SigningKey::from_bytes((&[7_u8; 32]).into()).expect("test key");
        let encoded = signing_key.verifying_key().to_sec1_point(false);
        let public_hash = Keccak256::digest(&encoded.as_bytes()[1..]);
        let address = format!("0x{}", hex::encode(&public_hash[12..]));
        let auth = AuthService::new(
            "localhost:3000".into(),
            "http://localhost:3000".into(),
            10_143,
            120,
        )
        .expect("auth config");
        let challenge = auth.create_challenge(&address).await.expect("challenge");
        let prefix = format!("\x19Ethereum Signed Message:\n{}", challenge.message.len());
        let hash = Keccak256::new()
            .chain_update(prefix.as_bytes())
            .chain_update(challenge.message.as_bytes())
            .finalize();
        let (signature, recovery_id) = signing_key.sign_prehash_recoverable(hash.as_ref());
        let mut bytes = signature.to_bytes().to_vec();
        bytes.push(recovery_id.to_byte() + 27);
        let session = auth
            .verify(VerifyInput {
                address: address.clone(),
                signature: format!("0x{}", hex::encode(bytes)),
            })
            .await
            .expect("valid session");
        assert_eq!(session.owner_id, address);
        assert_eq!(session.access_token.len(), 64);
        assert!(
            auth.verify(VerifyInput {
                address: session.owner_id,
                signature: "0x00".into(),
            })
            .await
            .is_err(),
            "a challenge must be single use"
        );
    }

    #[tokio::test]
    async fn challenge_and_session_limits_fail_closed() {
        let address = "0x1111111111111111111111111111111111111111";
        let auth = AuthService::new(
            "localhost:3000".into(),
            "http://localhost:3000".into(),
            10_143,
            2,
        )
        .expect("auth config");
        for _ in 0..5 {
            auth.create_challenge(address).await.expect("within limit");
        }
        assert!(auth.create_challenge(address).await.is_err());

        let now = OffsetDateTime::now_utc();
        auth.sessions.write().await.insert(
            "a".repeat(64),
            Session {
                owner_id: address.into(),
                expires_at: now + Duration::hours(1),
                rate_window: RateWindow {
                    started_at: now,
                    requests: 0,
                },
            },
        );
        assert!(auth.authenticate(&"a".repeat(64)).await.is_ok());
        assert!(auth.authenticate(&"a".repeat(64)).await.is_ok());
        assert!(auth.authenticate(&"a".repeat(64)).await.is_err());
        auth.revoke(&"a".repeat(64)).await;
        assert!(auth.authenticate(&"a".repeat(64)).await.is_err());
    }
}
