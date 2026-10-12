//! Quotas. A rule is `{metric, period, limit}`; every rule is optional.
//!
//! Metrics: `slices` (jobs), `filament_g`, `print_hours` (slicer estimates),
//! `storage_mb` (model + G-code kept on the server; a running total, the
//! period is ignored). Periods: `day`, `week` (from Monday), `month`,
//! `season` (the group's season, or the site's for user rules), `total`.
//! Boundaries are UTC.
//!
//! A job by user U charged to group G may start only when every applicable
//! counter is below its limit (the job that crosses a limit finishes):
//! 1. U's own rules (`users.quotas`, else the site default for the account
//!    kind) over all of U's jobs;
//! 2. for each group on G's path to the root, U's per-member rules (the
//!    membership's override, else the group's `guest` rules for guests when
//!    set, else its `member` rules) over U's jobs in that group's subtree;
//! 3. for each group on that path, its `pool` rules over every job in the
//!    group's subtree.
//!
//! Failed and cancelled jobs don't count.

use chrono::{Datelike, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::db::{Db, JobFilter, Usage, User};
use crate::groups::{parse_month_day, Tree};

pub const METRICS: &[&str] = &["slices", "filament_g", "print_hours", "storage_mb"];
pub const PERIODS: &[&str] = &["day", "week", "month", "season", "total"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Rule {
    pub metric: String,
    pub period: String,
    pub limit: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct GroupQuotas {
    /// Shared by everyone in the group's subtree.
    #[serde(default)]
    pub pool: Vec<Rule>,
    /// Per member, over their jobs in the subtree.
    #[serde(default)]
    pub member: Vec<Rule>,
    /// Per guest member; replaces `member` for guests when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guest: Option<Vec<Rule>>,
}

impl GroupQuotas {
    pub fn parse(json: &str) -> GroupQuotas {
        serde_json::from_str(json).unwrap_or_default()
    }

    pub fn validate(&self) -> Result<(), String> {
        validate_rules(&self.pool)?;
        validate_rules(&self.member)?;
        if let Some(g) = &self.guest {
            validate_rules(g)?;
        }
        Ok(())
    }
}

pub fn parse_rules(json: &str) -> Vec<Rule> {
    serde_json::from_str(json).unwrap_or_default()
}

pub fn validate_rules(rules: &[Rule]) -> Result<(), String> {
    for r in rules {
        if !METRICS.contains(&r.metric.as_str()) {
            return Err(format!("unknown quota metric '{}'", r.metric));
        }
        if !PERIODS.contains(&r.period.as_str()) {
            return Err(format!("unknown quota period '{}'", r.period));
        }
        if !r.limit.is_finite() || r.limit < 0.0 {
            return Err("quota limits must be zero or more".into());
        }
    }
    Ok(())
}

/// Site-wide default rules for an account kind (`settings` table).
pub fn site_default_rules(db: &Db, kind: &str) -> Vec<Rule> {
    let key = if kind == "guest" { "default_guest_quotas" } else { "default_user_quotas" };
    db.get_setting(key).map(|v| parse_rules(&v)).unwrap_or_default()
}

/// Start of the period containing today, as SQLite datetime text.
pub fn period_start(period: &str, season_start: &str) -> String {
    period_start_on(Utc::now().date_naive(), period, season_start)
}

fn period_start_on(today: NaiveDate, period: &str, season_start: &str) -> String {
    let day = match period {
        "day" => today,
        "week" => today - Duration::days(today.weekday().num_days_from_monday() as i64),
        "month" => today.with_day(1).unwrap_or(today),
        "season" => {
            let (m, d) = parse_month_day(season_start).unwrap_or((1, 1));
            let this_year = NaiveDate::from_ymd_opt(today.year(), m, d)
                .or_else(|| NaiveDate::from_ymd_opt(today.year(), m, d - 1))
                .unwrap_or(today);
            if this_year <= today {
                this_year
            } else {
                NaiveDate::from_ymd_opt(today.year() - 1, m, d)
                    .or_else(|| NaiveDate::from_ymd_opt(today.year() - 1, m, d - 1))
                    .unwrap_or(today)
            }
        }
        _ => return "0000-00-00 00:00:00".to_string(),
    };
    format!("{} 00:00:00", day.format("%Y-%m-%d"))
}

fn measure(usage: &Usage, metric: &str) -> f64 {
    match metric {
        "slices" => usage.slices as f64,
        "filament_g" => usage.filament_g,
        "print_hours" => usage.print_sec / 3600.0,
        "storage_mb" => usage.stored_bytes as f64 / 1_000_000.0,
        _ => 0.0,
    }
}

/// One evaluated rule.
#[derive(Debug, Clone, Serialize)]
pub struct Line {
    /// "user" | "member" | "pool"
    pub scope: &'static str,
    pub group_id: Option<String>,
    pub group_name: Option<String>,
    pub metric: String,
    pub period: String,
    pub since: String,
    pub limit: f64,
    pub used: f64,
}

impl Line {
    pub fn exhausted(&self) -> bool {
        self.used >= self.limit
    }

    pub fn describe(&self) -> String {
        let who = match (self.scope, &self.group_name) {
            ("user", _) => "your personal".to_string(),
            ("member", Some(g)) => format!("{g}'s per-member"),
            ("pool", Some(g)) => format!("{g}'s shared"),
            _ => "a".to_string(),
        };
        let what = match self.metric.as_str() {
            "slices" => "slice",
            "filament_g" => "filament (g)",
            "print_hours" => "print-hour",
            "storage_mb" => "storage (MB)",
            m => m,
        };
        let when = match self.period.as_str() {
            "day" => " for today",
            "week" => " for this week",
            "month" => " for this month",
            "season" => " for this season",
            _ => "",
        };
        format!(
            "{who} {what} quota{when} is used up ({:.1} of {:.1})",
            self.used, self.limit
        )
    }
}

fn evaluate_rules(
    db: &Db,
    out: &mut Vec<Line>,
    scope: &'static str,
    group: Option<(&str, &str)>,
    rules: &[Rule],
    filter: &JobFilter,
    season_start: &str,
) {
    for rule in rules {
        let since = if rule.metric == "storage_mb" {
            "0000-00-00 00:00:00".to_string()
        } else {
            period_start(&rule.period, season_start)
        };
        let usage = db.usage(filter, &since);
        out.push(Line {
            scope,
            group_id: group.map(|g| g.0.to_string()),
            group_name: group.map(|g| g.1.to_string()),
            metric: rule.metric.clone(),
            period: rule.period.clone(),
            since,
            limit: rule.limit,
            used: measure(&usage, &rule.metric),
        });
    }
}

/// U's own rules.
pub fn user_lines(db: &Db, tree: &Tree, user: &User) -> Vec<Line> {
    let rules = user
        .quotas
        .as_deref()
        .map(parse_rules)
        .unwrap_or_else(|| site_default_rules(db, &user.kind));
    let mut out = Vec::new();
    let filter = JobFilter { user_id: Some(user.id.clone()), ..Default::default() };
    evaluate_rules(db, &mut out, "user", None, &rules, &filter, tree.site_season_start());
    out
}

/// Per-member and pool rules along `group_id`'s path to the root, for U.
pub fn group_lines(db: &Db, tree: &Tree, user: &User, group_id: &str) -> Vec<Line> {
    let mut out = Vec::new();
    for g in tree.path(group_id) {
        let quotas = GroupQuotas::parse(&g.quotas);
        let subtree = tree.subtree(&g.id);
        let season = tree.effective(&g.id).season_start;
        let override_rules = db
            .get_membership(&g.id, &user.id)
            .and_then(|m| m.quotas)
            .map(|q| parse_rules(&q));
        let member_rules = override_rules.unwrap_or_else(|| match (&quotas.guest, user.kind.as_str()) {
            (Some(guest), "guest") => guest.clone(),
            _ => quotas.member.clone(),
        });
        let mine = JobFilter {
            user_id: Some(user.id.clone()),
            group_ids: Some(subtree.clone()),
            ..Default::default()
        };
        evaluate_rules(db, &mut out, "member", Some((&g.id, &g.name)), &member_rules, &mine, &season);
        let all = JobFilter { group_ids: Some(subtree), ..Default::default() };
        evaluate_rules(db, &mut out, "pool", Some((&g.id, &g.name)), &quotas.pool, &all, &season);
    }
    out
}

/// Every rule that applies to a job by `user` charged to `group_id`.
pub fn evaluate(db: &Db, tree: &Tree, user: &User, group_id: Option<&str>) -> Vec<Line> {
    let mut out = user_lines(db, tree, user);
    if let Some(gid) = group_id {
        out.extend(group_lines(db, tree, user, gid));
    }
    out
}

/// Err(reason) when any applicable quota is used up.
pub fn check(db: &Db, tree: &Tree, user: &User, group_id: Option<&str>) -> Result<(), String> {
    match evaluate(db, tree, user, group_id).iter().find(|l| l.exhausted()) {
        Some(line) => Err(format!("Quota reached: {}", line.describe())),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    #[test]
    fn periods() {
        // 2026-10-14 is a Wednesday.
        let today = d(2026, 10, 14);
        assert_eq!(period_start_on(today, "day", "01-01"), "2026-10-14 00:00:00");
        assert_eq!(period_start_on(today, "week", "01-01"), "2026-10-12 00:00:00");
        assert_eq!(period_start_on(today, "month", "01-01"), "2026-10-01 00:00:00");
        assert_eq!(period_start_on(today, "season", "01-01"), "2026-01-01 00:00:00");
        assert_eq!(period_start_on(today, "season", "11-01"), "2025-11-01 00:00:00");
        assert_eq!(period_start_on(today, "season", "09-01"), "2026-09-01 00:00:00");
        assert_eq!(period_start_on(today, "total", "01-01"), "0000-00-00 00:00:00");
    }

    #[test]
    fn rules_validate() {
        let ok = vec![Rule { metric: "filament_g".into(), period: "month".into(), limit: 500.0 }];
        assert!(validate_rules(&ok).is_ok());
        let bad = vec![Rule { metric: "gold".into(), period: "month".into(), limit: 1.0 }];
        assert!(validate_rules(&bad).is_err());
        let neg = vec![Rule { metric: "slices".into(), period: "day".into(), limit: -1.0 }];
        assert!(validate_rules(&neg).is_err());
    }
}
