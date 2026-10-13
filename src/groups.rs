//! Groups: a tree of named groups that users belong to (directly; a
//! group's ancestors supply inherited settings and quota rules). Policy
//! lives here; SQL in src/db.rs, HTTP in src/groups_api.rs and
//! src/join_api.rs, quotas in src/quota.rs.
//!
//! - Settings (`groups.settings`, JSON, every key optional) are inherited
//!   down the tree: the nearest group that sets a key wins, then the site
//!   default. `listed` and `subgroups` apply to the group itself only.
//! - `can_manage(G)`: admins, and active managers of G or any ancestor.
//! - A job charged to G is visible to its creator, G's active members when
//!   G's `shared_library` is on, anyone who can manage G, and admins.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::auth;
use crate::db::{Db, Group, Job, Membership, User};

/// Per-group settings as stored. `None` = inherit.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct GroupSettings {
    /// First day of a season, "MM-DD". Libraries split jobs by season.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub season_start: Option<String>,
    /// Members see each other's jobs charged to this group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_library: Option<bool>,
    /// Browser-sliced jobs charged here upload the source model too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_models: Option<bool>,
    /// Guest (credential-less) accounts may join through the join flow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_guests: Option<bool>,
    /// The join flow may create new passkey accounts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_registration: Option<bool>,
    /// "open": joiners become active members; "approval": they wait for a
    /// manager. Links with `bypass_approval` to this very group skip it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join_policy: Option<String>,
    /// Label drawn on the thumbnails of jobs charged here: `{key}` = the
    /// identifier the nearest group was created under (e.g. a team number),
    /// `{group}` = the group's name. "" = no label. See src/overlay.rs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thumbnail_label: Option<String>,
    /// What a print may be without approval (inherited as a whole; the site
    /// default applies to personal jobs). See src/printing.rs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub print_rules: Option<PrintRules>,
    /// Pre-sliced uploads (`.gcode.3mf` from Bambu Studio and the like):
    /// "allow", "review" (every print of one waits for approval) or "deny".
    /// Their G-code is checked either way (src/gcode/).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uploads: Option<String>,
    /// Not inherited. Offer this group on the sign-in page (admins only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listed: Option<bool>,
    /// Not inherited. How joiners pick a subgroup of this group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subgroups: Option<SubgroupPolicy>,
}

/// Limits on prints sent without approval. Missing = no limit.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PrintRules {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_minutes: Option<u32>,
    /// Allowed materials as printers name them ("PLA", "PLA-CF", "PETG"...),
    /// compared case-insensitively.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materials: Option<Vec<String>>,
}

impl PrintRules {
    pub fn validate(&self) -> Result<(), String> {
        if self.max_minutes == Some(0) {
            return Err("print_rules.max_minutes must be positive".into());
        }
        if let Some(m) = &self.materials {
            if m.iter().any(|x| x.trim().is_empty() || x.len() > 32) || m.len() > 64 {
                return Err("print_rules.materials: up to 64 names of 1-32 characters".into());
            }
        }
        Ok(())
    }

    /// The site default (setting `print_rules`).
    pub fn site_default(db: &Db) -> PrintRules {
        db.get_setting("print_rules")
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SubgroupPolicy {
    /// "none" | "choose" (pick an existing child) | "self_service" (type an
    /// identifier; the child is created when it doesn't exist yet).
    pub mode: String,
    /// Joining through this group means joining one of its children.
    #[serde(default)]
    pub required: bool,
    /// What the identifier is called, e.g. "Team number".
    #[serde(default)]
    pub label: String,
    /// Regex the identifier must match in full (self_service).
    #[serde(default)]
    pub pattern: String,
    /// Name of a created child; `{value}` is replaced by the identifier.
    #[serde(default)]
    pub name_template: String,
    /// Whoever creates a child becomes its manager.
    #[serde(default)]
    pub creator_becomes_manager: bool,
}

impl SubgroupPolicy {
    pub fn validate(&self) -> Result<(), String> {
        match self.mode.as_str() {
            "none" | "choose" => Ok(()),
            "self_service" => {
                if self.pattern.trim().is_empty() {
                    return Err("self-service subgroups need a pattern".into());
                }
                regex::Regex::new(&format!("^(?:{})$", self.pattern))
                    .map_err(|e| format!("pattern: {e}"))?;
                if !self.name_template.contains("{value}") {
                    return Err("name template must contain {value}".into());
                }
                Ok(())
            }
            _ => Err("subgroups.mode must be none, choose or self_service".into()),
        }
    }

    /// Normalise and check an identifier typed by a joiner.
    pub fn check_key(&self, key: &str) -> Result<String, String> {
        let key = key.trim();
        let re = regex::Regex::new(&format!("^(?:{})$", self.pattern))
            .map_err(|e| format!("pattern: {e}"))?;
        if key.is_empty() || key.len() > 64 || !re.is_match(key) {
            let what = if self.label.is_empty() { "identifier" } else { &self.label };
            return Err(format!("that is not a valid {what}"));
        }
        Ok(key.to_string())
    }

    pub fn child_name(&self, key: &str) -> String {
        self.name_template.replace("{value}", key)
    }
}

impl GroupSettings {
    pub fn parse(json: &str) -> GroupSettings {
        serde_json::from_str(json).unwrap_or_default()
    }

    pub fn validate(&self) -> Result<(), String> {
        if let Some(s) = &self.season_start {
            parse_month_day(s).ok_or("season_start must be MM-DD")?;
        }
        if let Some(p) = &self.join_policy {
            if !matches!(p.as_str(), "open" | "approval") {
                return Err("join_policy must be open or approval".into());
            }
        }
        if let Some(sub) = &self.subgroups {
            sub.validate()?;
        }
        if self.thumbnail_label.as_ref().is_some_and(|l| l.chars().count() > 64) {
            return Err("thumbnail_label is limited to 64 characters".into());
        }
        if let Some(r) = &self.print_rules {
            r.validate()?;
        }
        if let Some(u) = &self.uploads {
            validate_uploads(u)?;
        }
        Ok(())
    }
}

pub const UPLOAD_POLICIES: &[&str] = &["allow", "review", "deny"];

pub fn validate_uploads(policy: &str) -> Result<(), String> {
    if UPLOAD_POLICIES.contains(&policy) {
        Ok(())
    } else {
        Err("uploads must be allow, review or deny".into())
    }
}

/// The site's upload policy (setting `uploads`): personal jobs, and groups
/// that set none.
pub fn site_uploads(db: &Db) -> String {
    db.get_setting("uploads")
        .filter(|u| validate_uploads(u).is_ok())
        .unwrap_or_else(|| "allow".to_string())
}

/// "MM-DD" → (month, day).
pub fn parse_month_day(s: &str) -> Option<(u32, u32)> {
    let (m, d) = s.trim().split_once('-')?;
    let (m, d): (u32, u32) = (m.parse().ok()?, d.parse().ok()?);
    let max = match m {
        2 => 29,
        4 | 6 | 9 | 11 => 30,
        1..=12 => 31,
        _ => return None,
    };
    (1..=max).contains(&d).then_some((m, d))
}

/// Settings after inheritance, with the id of the group each came from
/// (None = site default).
#[derive(Debug, Clone, Serialize)]
pub struct Effective {
    pub season_start: String,
    pub shared_library: bool,
    pub keep_models: bool,
    pub allow_guests: bool,
    pub allow_registration: bool,
    pub join_policy: String,
    pub thumbnail_label: String,
    pub print_rules: PrintRules,
    pub uploads: String,
    pub sources: HashMap<&'static str, Option<String>>,
}

/// The whole group tree, loaded per request (groups are few and small).
pub struct Tree {
    pub groups: HashMap<String, Group>,
    settings: HashMap<String, GroupSettings>,
    children: HashMap<String, Vec<String>>,
    site_season_start: String,
    site_print_rules: PrintRules,
    site_uploads: String,
}

impl Tree {
    pub fn load(db: &Db) -> Tree {
        let list = db.list_groups();
        let mut children: HashMap<String, Vec<String>> = HashMap::new();
        let mut settings = HashMap::new();
        for g in &list {
            if let Some(p) = &g.parent_id {
                children.entry(p.clone()).or_default().push(g.id.clone());
            }
            settings.insert(g.id.clone(), GroupSettings::parse(&g.settings));
        }
        let site_season_start = db
            .get_setting("season_start")
            .and_then(|v| serde_json::from_str::<String>(&v).ok())
            .filter(|s| parse_month_day(s).is_some())
            .unwrap_or_else(|| "01-01".to_string());
        Tree {
            groups: list.into_iter().map(|g| (g.id.clone(), g)).collect(),
            settings,
            children,
            site_season_start,
            site_print_rules: PrintRules::site_default(db),
            site_uploads: site_uploads(db),
        }
    }

    pub fn get(&self, id: &str) -> Option<&Group> {
        self.groups.get(id)
    }

    pub fn settings(&self, id: &str) -> GroupSettings {
        self.settings.get(id).cloned().unwrap_or_default()
    }

    pub fn site_season_start(&self) -> &str {
        &self.site_season_start
    }

    pub fn site_print_rules(&self) -> &PrintRules {
        &self.site_print_rules
    }

    pub fn site_uploads(&self) -> &str {
        &self.site_uploads
    }

    /// `id` first, then its parent, ... up to the root. Stops on a cycle.
    pub fn path(&self, id: &str) -> Vec<&Group> {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        let mut cur = self.groups.get(id);
        while let Some(g) = cur {
            if !seen.insert(g.id.as_str()) {
                break;
            }
            out.push(g);
            cur = g.parent_id.as_deref().and_then(|p| self.groups.get(p));
        }
        out
    }

    pub fn children(&self, id: &str) -> Vec<&Group> {
        let mut out: Vec<&Group> = self
            .children
            .get(id)
            .map(|ids| ids.iter().filter_map(|c| self.groups.get(c)).collect())
            .unwrap_or_default();
        out.sort_by(|a, b| natural_cmp(&a.name, &b.name));
        out
    }

    /// `id` and all of its descendants.
    pub fn subtree(&self, id: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![id.to_string()];
        let mut seen = HashSet::new();
        while let Some(cur) = stack.pop() {
            if !seen.insert(cur.clone()) {
                continue;
            }
            if let Some(kids) = self.children.get(&cur) {
                stack.extend(kids.iter().cloned());
            }
            out.push(cur);
        }
        out
    }

    /// Is `id` equal to `ancestor` or below it?
    pub fn is_within(&self, id: &str, ancestor: &str) -> bool {
        self.path(id).iter().any(|g| g.id == ancestor)
    }

    /// "League / Program / Team 42".
    pub fn display_path(&self, id: &str) -> String {
        let mut names: Vec<&str> = self.path(id).iter().map(|g| g.name.as_str()).collect();
        names.reverse();
        names.join(" / ")
    }

    pub fn effective(&self, id: &str) -> Effective {
        let path = self.path(id);
        let mut sources: HashMap<&'static str, Option<String>> = HashMap::new();
        macro_rules! inherit {
            ($field:ident, $default:expr) => {{
                let mut value = None;
                for g in &path {
                    if let Some(v) = self.settings.get(&g.id).and_then(|s| s.$field.clone()) {
                        sources.insert(stringify!($field), Some(g.id.clone()));
                        value = Some(v);
                        break;
                    }
                }
                value.unwrap_or_else(|| {
                    sources.insert(stringify!($field), None);
                    $default
                })
            }};
        }
        Effective {
            season_start: inherit!(season_start, self.site_season_start.clone()),
            shared_library: inherit!(shared_library, true),
            keep_models: inherit!(keep_models, false),
            allow_guests: inherit!(allow_guests, false),
            allow_registration: inherit!(allow_registration, false),
            join_policy: inherit!(join_policy, "approval".to_string()),
            thumbnail_label: inherit!(thumbnail_label, String::new()),
            print_rules: inherit!(print_rules, self.site_print_rules.clone()),
            uploads: inherit!(uploads, self.site_uploads.clone()),
            sources,
        }
    }

    /// Groups offered on the sign-in page.
    pub fn listed(&self) -> Vec<&Group> {
        let mut out: Vec<&Group> = self
            .groups
            .values()
            .filter(|g| self.settings.get(&g.id).and_then(|s| s.listed).unwrap_or(false))
            .collect();
        out.sort_by(|a, b| natural_cmp(&a.name, &b.name));
        out
    }
}

/// Compare names so "Team 9" sorts before "Team 10".
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    fn chunks(s: &str) -> Vec<(bool, String)> {
        let mut out: Vec<(bool, String)> = Vec::new();
        for c in s.chars() {
            let digit = c.is_ascii_digit();
            match out.last_mut() {
                Some((d, buf)) if *d == digit => buf.push(c),
                _ => out.push((digit, c.to_string())),
            }
        }
        out
    }
    let (ca, cb) = (chunks(a), chunks(b));
    for ((da, sa), (db, sb)) in ca.iter().zip(cb.iter()) {
        let ord = if *da && *db {
            let (ta, tb) = (sa.trim_start_matches('0'), sb.trim_start_matches('0'));
            ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb))
        } else {
            sa.to_lowercase().cmp(&sb.to_lowercase())
        };
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    ca.len().cmp(&cb.len())
}

/// The requesting user plus their memberships.
pub struct Viewer {
    pub user: User,
    pub admin: bool,
    pub memberships: Vec<Membership>,
}

impl Viewer {
    pub fn load(db: &Db, user: &User) -> Viewer {
        Viewer {
            user: user.clone(),
            admin: auth::is_admin(user),
            memberships: db.memberships_of_user(&user.id),
        }
    }

    pub fn membership(&self, group_id: &str) -> Option<&Membership> {
        self.memberships.iter().find(|m| m.group_id == group_id)
    }

    pub fn is_active_member(&self, group_id: &str) -> bool {
        self.membership(group_id).is_some_and(|m| m.status == "active")
    }

    fn managed_roots(&self) -> impl Iterator<Item = &str> {
        self.memberships
            .iter()
            .filter(|m| m.status == "active" && m.role == "manager")
            .map(|m| m.group_id.as_str())
    }

    /// Admin, or an active manager of the group or of an ancestor.
    pub fn can_manage(&self, tree: &Tree, group_id: &str) -> bool {
        self.admin || self.managed_roots().any(|root| tree.is_within(group_id, root))
    }

    /// Admin, or an active manager of a strict ancestor (quotas, deletion:
    /// a group's own managers cannot raise their own limits).
    pub fn can_govern(&self, tree: &Tree, group_id: &str) -> bool {
        if self.admin {
            return true;
        }
        let path = tree.path(group_id);
        self.managed_roots()
            .any(|root| path.iter().skip(1).any(|g| g.id == root))
    }

    /// Groups whose jobs this viewer may see (beyond their own jobs).
    /// None = all (admins).
    pub fn visible_groups(&self, tree: &Tree) -> Option<Vec<String>> {
        if self.admin {
            return None;
        }
        let mut out: HashSet<String> = HashSet::new();
        for m in &self.memberships {
            if m.status != "active" {
                continue;
            }
            if m.role == "manager" {
                out.extend(tree.subtree(&m.group_id));
            } else if tree.effective(&m.group_id).shared_library {
                out.insert(m.group_id.clone());
            }
        }
        Some(out.into_iter().collect())
    }

    pub fn can_see_job(&self, tree: &Tree, job: &Job) -> bool {
        if self.admin || job.user_id.as_deref() == Some(self.user.id.as_str()) {
            return true;
        }
        let Some(gid) = &job.group_id else { return false };
        if self.can_manage(tree, gid) {
            return true;
        }
        self.is_active_member(gid) && tree.effective(gid).shared_library
    }

    /// Groups the viewer may charge a job to: active memberships.
    pub fn can_charge(&self, group_id: &str) -> bool {
        self.is_active_member(group_id)
    }

    /// The viewer's groups for the job-group picker, path-labelled.
    pub fn chargeable(&self, tree: &Tree) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = self
            .memberships
            .iter()
            .filter(|m| m.status == "active")
            .filter(|m| tree.get(&m.group_id).is_some())
            .map(|m| (m.group_id.clone(), tree.display_path(&m.group_id)))
            .collect();
        out.sort_by(|a, b| natural_cmp(&a.1, &b.1));
        out
    }
}

/// Season of a SQLite datetime ("YYYY-MM-DD HH:MM:SS") for a season that
/// starts on `season_start` ("MM-DD"): the year the season began.
pub fn season_year(datetime: &str, season_start: &str) -> i32 {
    let year: i32 = datetime.get(0..4).and_then(|y| y.parse().ok()).unwrap_or(1970);
    let md = datetime.get(5..10).unwrap_or("01-01");
    let start = parse_month_day(season_start).unwrap_or((1, 1));
    let start_md = format!("{:02}-{:02}", start.0, start.1);
    if md >= start_md.as_str() { year } else { year - 1 }
}

/// "2026" for seasons starting Jan 1, "2026–27" otherwise.
pub fn season_label(year: i32, season_start: &str) -> String {
    match parse_month_day(season_start) {
        Some((1, 1)) | None => year.to_string(),
        _ => format!("{year}–{:02}", (year + 1) % 100),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seasons() {
        assert_eq!(season_year("2026-03-04 10:00:00", "01-01"), 2026);
        assert_eq!(season_year("2026-03-04 10:00:00", "09-01"), 2025);
        assert_eq!(season_year("2026-09-01 00:00:00", "09-01"), 2026);
        assert_eq!(season_label(2025, "09-01"), "2025–26");
        assert_eq!(season_label(2026, "01-01"), "2026");
    }

    #[test]
    fn month_day() {
        assert_eq!(parse_month_day("01-07"), Some((1, 7)));
        assert_eq!(parse_month_day("02-30"), None);
        assert_eq!(parse_month_day("13-01"), None);
    }

    #[test]
    fn natural_order() {
        let mut v = vec!["Team 10", "Team 9", "team 100", "Alpha"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, vec!["Alpha", "Team 9", "Team 10", "team 100"]);
    }

    #[test]
    fn self_service_keys() {
        let p = SubgroupPolicy {
            mode: "self_service".into(),
            required: true,
            label: "Number".into(),
            pattern: "[0-9]{1,5}".into(),
            name_template: "Unit {value}".into(),
            creator_becomes_manager: true,
        };
        p.validate().unwrap();
        assert_eq!(p.check_key(" 254 ").unwrap(), "254");
        assert!(p.check_key("254a").is_err());
        assert!(p.check_key("123456").is_err());
        assert_eq!(p.child_name("254"), "Unit 254");
    }
}
