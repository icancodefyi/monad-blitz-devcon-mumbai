//! Draft-only marketing campaigns grounded in a reusable brand profile.

use std::collections::HashSet;

use async_trait::async_trait;
use donads_core::{Bot, BotDescriptor, BotError, BotResult, Task};
use serde::{Deserialize, Serialize};
use serde_json::json;

const AGENT_VERSION: &str = "growth-campaign-v1";
const MAX_DAYS: u8 = 30;

/// Durable brand context shared across Growth tasks for one project.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct BrandProfile {
    pub id: String,
    pub project_name: String,
    pub product_description: String,
    pub target_audience: String,
    pub preferred_tone: String,
    #[serde(default)]
    pub terminology: Vec<String>,
    pub value_propositions: Vec<String>,
    #[serde(default)]
    pub approved_links: Vec<String>,
    #[serde(default)]
    pub prohibited_terms: Vec<String>,
    #[serde(default)]
    pub previous_approved_examples: Vec<String>,
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub updated_at_ms: u64,
}

/// Structured input accepted by Growth.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GrowthInput {
    pub objective: String,
    pub start_date: String,
    pub duration_days: u8,
    pub platforms: Vec<String>,
    pub profile: BrandProfile,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Evidence {
    pub text: String,
    pub source_url: String,
}

#[derive(Debug, Serialize)]
struct CampaignDay {
    day: u8,
    date: String,
    platform: String,
    format: &'static str,
    objective: String,
    draft: String,
    call_to_action: String,
    visual_asset: String,
    status: &'static str,
    evidence_urls: Vec<String>,
}

/// Growth produces reviewable drafts and never calls publishing integrations.
#[derive(Default)]
pub struct Growth;

#[async_trait]
impl Bot for Growth {
    fn descriptor(&self) -> BotDescriptor {
        BotDescriptor {
            id: "growth",
            name: "Growth",
            specialty: "Draft-only campaigns, content, and community operations",
            available: true,
        }
    }

    async fn execute(&self, task: &Task) -> Result<BotResult, BotError> {
        let input: GrowthInput = serde_json::from_value(task.input.clone()).map_err(|error| {
            BotError::InvalidInput(format!(
                "Growth requires a structured campaign brief: {error}"
            ))
        })?;
        validate_input(&input)?;
        let calendar = build_calendar(&input)?;
        let asset_count = calendar
            .iter()
            .map(|day| day.visual_asset.as_str())
            .collect::<HashSet<_>>()
            .len();
        let summary = format!(
            "Growth prepared a {}-day campaign with {} draft(s) for {}. Nothing was published.",
            input.duration_days,
            calendar.len(),
            input.profile.project_name
        );

        Ok(BotResult {
            summary,
            data: json!({
                "campaign": {
                    "project_name": input.profile.project_name,
                    "objective": input.objective,
                    "target_audience": input.profile.target_audience,
                    "tone": input.profile.preferred_tone,
                    "message_pillars": input.profile.value_propositions,
                    "calendar": calendar,
                    "required_asset_count": asset_count,
                    "restrictions_applied": input.profile.prohibited_terms,
                    "status": "draft",
                    "publishing": "disabled"
                },
                "agent_version": AGENT_VERSION,
                "external_actions": false
            }),
        })
    }
}

fn validate_input(input: &GrowthInput) -> Result<(), BotError> {
    for (label, value) in [
        ("objective", input.objective.as_str()),
        ("profile.id", input.profile.id.as_str()),
        ("profile.project_name", input.profile.project_name.as_str()),
        (
            "profile.product_description",
            input.profile.product_description.as_str(),
        ),
        (
            "profile.target_audience",
            input.profile.target_audience.as_str(),
        ),
        (
            "profile.preferred_tone",
            input.profile.preferred_tone.as_str(),
        ),
    ] {
        if value.trim().is_empty() {
            return Err(BotError::InvalidInput(format!("{label} cannot be empty")));
        }
    }
    if !(1..=MAX_DAYS).contains(&input.duration_days) {
        return Err(BotError::InvalidInput(format!(
            "duration_days must be between 1 and {MAX_DAYS}"
        )));
    }
    if input.platforms.is_empty() {
        return Err(BotError::InvalidInput(
            "select at least one platform".into(),
        ));
    }
    if input.profile.value_propositions.is_empty() {
        return Err(BotError::InvalidInput(
            "profile.value_propositions must contain at least one item".into(),
        ));
    }
    for platform in &input.platforms {
        if !matches!(platform.as_str(), "x" | "linkedin" | "community" | "email") {
            return Err(BotError::InvalidInput(format!(
                "unsupported platform '{platform}'"
            )));
        }
    }
    parse_date(&input.start_date)?;
    Ok(())
}

fn build_calendar(input: &GrowthInput) -> Result<Vec<CampaignDay>, BotError> {
    let mut date = parse_date(&input.start_date)?;
    let mut calendar = Vec::with_capacity(usize::from(input.duration_days));
    for day in 1..=input.duration_days {
        let platform_index = usize::from(day - 1) % input.platforms.len();
        let platform = &input.platforms[platform_index];
        let pillar_index = usize::from(day - 1) % input.profile.value_propositions.len();
        let pillar = &input.profile.value_propositions[pillar_index];
        let evidence = input
            .evidence
            .get(usize::from(day - 1) % input.evidence.len().max(1));
        let call_to_action = call_to_action(&input.profile, platform);
        let mut draft = draft_for(platform, day, input, pillar, evidence, &call_to_action);
        draft = remove_prohibited_terms(draft, &input.profile.prohibited_terms);
        if platform == "x" {
            draft = truncate_chars(&draft, 280);
        }
        calendar.push(CampaignDay {
            day,
            date: format_date(date),
            platform: platform.clone(),
            format: format_for(platform, day),
            objective: objective_for(day, input.duration_days).into(),
            draft,
            call_to_action,
            visual_asset: visual_for(platform, day).into(),
            status: "draft",
            evidence_urls: evidence
                .map(|item| vec![item.source_url.clone()])
                .unwrap_or_default(),
        });
        date = next_date(date);
    }
    Ok(calendar)
}

fn draft_for(
    platform: &str,
    day: u8,
    input: &GrowthInput,
    pillar: &str,
    evidence: Option<&Evidence>,
    call_to_action: &str,
) -> String {
    let project = &input.profile.project_name;
    let description = input.profile.product_description.trim_end_matches('.');
    let evidence_line = evidence.map_or(String::new(), |item| format!(" Evidence: {}.", item.text));
    match platform {
        "x" => format!("{project}: {description}. {pillar}.{evidence_line} {call_to_action}"),
        "linkedin" => format!(
            "We built {project} for {}.\n\n{description}.\n\nWhy it matters: {pillar}.{evidence_line}\n\n{call_to_action}",
            input.profile.target_audience
        ),
        "community" => format!(
            "Day {day} update — {project}\n\n{description}. Today's focus: {pillar}.{evidence_line}\n\n{call_to_action}"
        ),
        "email" => format!(
            "Subject: {project} — {pillar}\n\nHi there,\n\n{description}. We designed it for {}. {evidence_line}\n\n{call_to_action}\n\n— The {project} team",
            input.profile.target_audience
        ),
        _ => unreachable!("platforms are validated before generation"),
    }
}

fn call_to_action(profile: &BrandProfile, platform: &str) -> String {
    let link = profile.approved_links.first().map_or("", String::as_str);
    let action = match platform {
        "community" => "Reply with the workflow you want us to cover next.",
        "email" => "Read the product overview and send us your questions.",
        _ => "Explore the product and tell us what you would build with it.",
    };
    if link.is_empty() {
        action.into()
    } else {
        format!("{action} {link}")
    }
}

fn objective_for(day: u8, total: u8) -> &'static str {
    if day == 1 {
        "Introduce the problem and project"
    } else if day == total {
        "Recap the campaign and invite action"
    } else if day.is_multiple_of(3) {
        "Build credibility with evidence"
    } else {
        "Explain one product value proposition"
    }
}

fn format_for(platform: &str, day: u8) -> &'static str {
    match (platform, day.is_multiple_of(3)) {
        ("x", true) => "thread opener",
        ("x", false) => "single post",
        ("linkedin", _) => "professional post",
        ("community", _) => "community announcement",
        ("email", _) => "email draft",
        _ => unreachable!("platforms are validated before generation"),
    }
}

fn visual_for(platform: &str, day: u8) -> &'static str {
    match (platform, day.is_multiple_of(2)) {
        ("email", _) => "Product screenshot with descriptive alt text",
        (_, true) => "Feature card using the approved brand system",
        (_, false) => "Editorial product visual using the approved brand system",
    }
}

fn remove_prohibited_terms(mut value: String, prohibited_terms: &[String]) -> String {
    for term in prohibited_terms {
        if !term.trim().is_empty() {
            value = replace_case_insensitive(&value, term.trim(), "[restricted term removed]");
        }
    }
    value
}

fn replace_case_insensitive(value: &str, needle: &str, replacement: &str) -> String {
    let lower_value = value.to_ascii_lowercase();
    let lower_needle = needle.to_ascii_lowercase();
    let mut output = String::new();
    let mut offset = 0;
    while let Some(relative) = lower_value[offset..].find(&lower_needle) {
        let start = offset + relative;
        output.push_str(&value[offset..start]);
        output.push_str(replacement);
        offset = start + needle.len();
    }
    output.push_str(&value[offset..]);
    output
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.into();
    }
    let mut shortened: String = value.chars().take(limit.saturating_sub(1)).collect();
    shortened.push('…');
    shortened
}

type Date = (i32, u8, u8);

fn parse_date(value: &str) -> Result<Date, BotError> {
    let parts: Vec<_> = value.split('-').collect();
    if parts.len() != 3 {
        return Err(BotError::InvalidInput(
            "start_date must use YYYY-MM-DD".into(),
        ));
    }
    let year = parts[0]
        .parse::<i32>()
        .map_err(|_| BotError::InvalidInput("start_date has an invalid year".into()))?;
    let month = parts[1]
        .parse::<u8>()
        .map_err(|_| BotError::InvalidInput("start_date has an invalid month".into()))?;
    let day = parts[2]
        .parse::<u8>()
        .map_err(|_| BotError::InvalidInput("start_date has an invalid day".into()))?;
    if !(2020..=2200).contains(&year)
        || !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
    {
        return Err(BotError::InvalidInput(
            "start_date is not a valid date".into(),
        ));
    }
    Ok((year, month, day))
}

fn next_date((mut year, mut month, mut day): Date) -> Date {
    if day < days_in_month(year, month) {
        day += 1;
    } else {
        day = 1;
        if month == 12 {
            month = 1;
            year += 1;
        } else {
            month += 1;
        }
    }
    (year, month, day)
}

fn days_in_month(year: i32, month: u8) -> u8 {
    match month {
        4 | 6 | 9 | 11 => 30,
        2 if year % 400 == 0 || (year % 4 == 0 && year % 100 != 0) => 29,
        2 => 28,
        _ => 31,
    }
}

fn format_date((year, month, day): Date) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}

#[cfg(test)]
mod tests {
    use donads_core::{Bot, Task, TaskInput};
    use serde_json::{Value, json};

    use super::{Growth, next_date, parse_date};

    fn task() -> Task {
        Task::queued(
            TaskInput {
                prompt: "Create a launch campaign".into(),
                bot: Some("growth".into()),
                input: json!({
                    "objective": "Launch the beta",
                    "start_date": "2028-02-27",
                    "duration_days": 7,
                    "platforms": ["x", "linkedin", "community", "email"],
                    "profile": {
                        "id": "donads",
                        "project_name": "DONADS",
                        "product_description": "An AI workforce for Monad teams",
                        "target_audience": "Web3 founders",
                        "preferred_tone": "precise and playful",
                        "terminology": ["agent"],
                        "value_propositions": ["Source-linked work", "Durable execution"],
                        "approved_links": ["https://example.com"],
                        "prohibited_terms": ["revolutionary"],
                        "previous_approved_examples": []
                    }
                }),
            },
            "growth".into(),
        )
    }

    #[tokio::test]
    async fn creates_seven_platform_specific_drafts() {
        let result = Growth
            .execute(&task())
            .await
            .expect("campaign should succeed");
        let calendar = result.data["campaign"]["calendar"]
            .as_array()
            .expect("calendar should be an array");
        assert_eq!(calendar.len(), 7);
        assert_eq!(calendar[0]["date"], "2028-02-27");
        assert_eq!(calendar[2]["date"], "2028-02-29");
        assert!(calendar.iter().all(|day| day["status"] == "draft"));
        assert!(
            calendar[0]["draft"]
                .as_str()
                .unwrap_or_default()
                .chars()
                .count()
                <= 280
        );
    }

    #[tokio::test]
    async fn rejects_missing_brand_value() {
        let mut invalid = task();
        invalid.input["profile"]["value_propositions"] = Value::Array(Vec::new());
        assert!(Growth.execute(&invalid).await.is_err());
    }

    #[test]
    fn handles_leap_year_boundaries() {
        assert_eq!(
            next_date(parse_date("2028-02-28").expect("valid date")),
            (2028, 2, 29)
        );
        assert_eq!(
            next_date(parse_date("2100-02-28").expect("valid date")),
            (2100, 3, 1)
        );
    }
}
