//! Who may print on which printer (`plans/organization-and-access.md`,
//! slice 2). Storage in src/db/access.rs, API in src/access_api.rs.
//!
//! An access rule says, for a **target** (one printer, a pool, a printer
//! model, or the whole site), that a **principal** (everyone, an account,
//! a group's members (with its subgroups), holders of a site role, or
//! holders of a certification) may print (`allow`), may ask for approval
//! (`approve`), or may not (`deny`). Rules are read from the most
//! specific target down (printer, its pools, its model, site), each
//! target's in the order given; the first rule that matches decides. No
//! match: allowed, as before rules existed.
//!
//! The person asking is who counts: whoever sends, or for a queued plate,
//! whoever queued it. "Operate every printer" is exempt. An `approve` hold
//! is lifted by anyone holding "approve prints" site-wide, the printer's
//! pool operators, or the rule's own approvers; a sender who could approve
//! it sends straight away.

use serde::Serialize;

use crate::db::{AccessRule, Db, Printer, Principal};
use crate::groups::{Tree, Viewer};
use crate::permissions::Cap;
use crate::server::AppState;

pub const TARGET_KINDS: &[&str] = &["printer", "pool", "model", "site"];
pub const PRINCIPAL_KINDS: &[&str] = &["everyone", "user", "group", "role", "certified"];
pub const EFFECTS: &[&str] = &["allow", "approve", "deny"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Effect {
    Allow,
    Approve,
    Deny,
}

/// What the rules say about one person and one printer.
#[derive(Debug, Clone, Serialize)]
pub struct Decision {
    pub effect: Effect,
    /// The rule that decided (None: no rule matched, or exempt).
    pub rule_id: Option<String>,
    /// Why, for people ("Printing on H2D-1 needs approval: ...").
    pub why: Option<String>,
    #[serde(skip)]
    pub approvers: Vec<Principal>,
}

impl Decision {
    fn allow() -> Decision {
        Decision { effect: Effect::Allow, rule_id: None, why: None, approvers: Vec::new() }
    }
}

/// The targets that apply to a printer, most specific first.
pub fn targets_for(db: &Db, printer: &Printer) -> Vec<(&'static str, String)> {
    let mut out = vec![("printer", printer.id.clone())];
    for pool in db.list_pools().into_iter().filter(|p| p.printer_ids.contains(&printer.id)) {
        out.push(("pool", pool.id));
    }
    let model = printer.machine_profile.trim();
    if !model.is_empty() {
        out.push(("model", model.to_string()));
    }
    out.push(("site", String::new()));
    out
}

/// Does `who` (None: nobody signed in, e.g. a queue entry without its
/// maker) fall under `p`?
pub fn matches(db: &Db, tree: &Tree, who: Option<&Viewer>, p: &Principal) -> bool {
    match (p.kind.as_str(), who) {
        ("everyone", _) => true,
        (_, None) => false,
        ("user", Some(v)) => v.user.id == p.id,
        ("role", Some(v)) => v.user.role == p.id,
        ("group", Some(v)) => v
            .memberships
            .iter()
            .any(|m| m.status == "active" && tree.get(&p.id).is_some() && tree.is_within(&m.group_id, &p.id)),
        ("certified", Some(v)) => db.certs_of_user(&v.user.id).iter().any(|c| c.cert_id == p.id && c.valid),
        _ => false,
    }
}

/// What the rules say about `who` printing on `printer`.
pub fn decide(db: &Db, tree: &Tree, who: Option<&Viewer>, printer: &Printer) -> Decision {
    if who.is_some_and(|v| v.can(Cap::PrintersOperate)) {
        return Decision::allow();
    }
    let rules = db.list_access_rules();
    for (kind, id) in targets_for(db, printer) {
        let mut here: Vec<&AccessRule> = rules.iter().filter(|r| r.target_kind == kind && r.target_id == id).collect();
        here.sort_by_key(|r| r.position);
        if let Some(r) = here.into_iter().find(|r| matches(db, tree, who, &r.principal)) {
            let note = if r.note.trim().is_empty() { String::new() } else { format!(": {}", r.note.trim()) };
            return match r.effect.as_str() {
                "deny" => Decision {
                    effect: Effect::Deny,
                    rule_id: Some(r.id.clone()),
                    why: Some(format!("{} isn't open to you{note}", printer.name)),
                    approvers: Vec::new(),
                },
                "approve" => Decision {
                    effect: Effect::Approve,
                    rule_id: Some(r.id.clone()),
                    why: Some(format!("printing on {} needs approval{note}", printer.name)),
                    approvers: r.approvers.clone(),
                },
                _ => Decision { rule_id: Some(r.id.clone()), ..Decision::allow() },
            };
        }
    }
    Decision::allow()
}

/// May `approver` lift an access hold on `printer` that names `approvers`?
pub fn can_approve(state: &AppState, tree: &Tree, approver: &Viewer, printer_id: Option<&str>, approvers: &[Principal]) -> bool {
    approver.can(Cap::PrintsApprove)
        || crate::pools::operates(state, approver, printer_id)
        || approvers.iter().any(|p| p.kind != "everyone" && matches(&state.db, tree, Some(approver), p))
}

/// Check a principal names something that exists.
pub fn validate_principal(db: &Db, tree: &Tree, p: &Principal) -> Result<(), String> {
    match p.kind.as_str() {
        "everyone" => Ok(()),
        "user" if db.get_user(&p.id).is_some() => Ok(()),
        "group" if tree.get(&p.id).is_some() => Ok(()),
        "role" if crate::permissions::role(db, &p.id).is_some_and(|r| r.scope == crate::permissions::Scope::Site) => Ok(()),
        "certified" if db.get_certification(&p.id).is_some() => Ok(()),
        k if PRINCIPAL_KINDS.contains(&k) => Err(format!("no such {k}: '{}'", p.id)),
        k => Err(format!("who: one of {} (not '{k}')", PRINCIPAL_KINDS.join(", "))),
    }
}

/// A principal as people read it ("members of Club", "holders of H2D training").
pub fn describe(db: &Db, tree: &Tree, p: &Principal) -> String {
    match p.kind.as_str() {
        "everyone" => "everyone".into(),
        "user" => db.get_user(&p.id).map(|u| u.username).unwrap_or_else(|| "a removed account".into()),
        "group" => format!("members of {}", if tree.get(&p.id).is_some() { tree.display_path(&p.id) } else { "a removed group".into() }),
        "role" => format!(
            "{} accounts",
            crate::permissions::role(db, &p.id).map(|r| r.name).unwrap_or_else(|| "a removed role's".into())
        ),
        "certified" => format!(
            "holders of {}",
            db.get_certification(&p.id).map(|c| c.name).unwrap_or_else(|| "a removed certification".into())
        ),
        other => other.into(),
    }
}
