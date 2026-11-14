//! Capabilities and roles (`plans/organization-and-access.md`).
//!
//! What an account may do is a set of **capabilities**: site capabilities
//! from its site role (`users.role`), and group capabilities from its role
//! in each group it belongs to (`group_members.role`), which hold in that
//! group and every group below it. Roles are built in (`owner`, `admin`,
//! `user`; `manager`, `member`) or made by admins from the fixed lists
//! here (table `roles`, src/db/roles.rs). Built-in roles live in code so
//! a new capability reaches them without a migration.
//!
//! Two rules keep custom roles from becoming a way up: nobody grants a
//! capability they don't hold (making a role, giving one), and nobody acts
//! on an account whose site capabilities aren't a subset of their own.
//! The owner is above everyone and can only be changed by the owner.

use serde::Serialize;
use std::collections::HashMap;
use std::marker::PhantomData;

use crate::db::Db;

/// One list of capabilities: ids as stored and sent, labels for the UI.
pub trait Capability: Copy + Eq + 'static {
    const ALL: &'static [Self];
    fn id(self) -> &'static str;
    fn label(self) -> &'static str;
    fn description(self) -> &'static str;
    fn bit(self) -> u32;
    fn from_id(id: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|c| c.id() == id)
    }
}

macro_rules! capabilities {
    ($name:ident { $($variant:ident = $id:literal, $label:literal, $desc:literal;)* }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name { $($variant),* }

        impl Capability for $name {
            const ALL: &'static [Self] = &[$($name::$variant),*];
            fn id(self) -> &'static str {
                match self { $($name::$variant => $id),* }
            }
            fn label(self) -> &'static str {
                match self { $($name::$variant => $label),* }
            }
            fn description(self) -> &'static str {
                match self { $($name::$variant => $desc),* }
            }
            fn bit(self) -> u32 {
                1 << (self as u32)
            }
        }
    };
}

capabilities!(Cap {
    UsersView = "users.view", "See accounts",
        "The Users page: every account, its groups, limits and G-code incidents.";
    UsersManage = "users.manage", "Manage accounts",
        "Invite, edit, suspend and delete accounts, and give them roles (only accounts and roles with no more than your own capabilities).";
    RolesManage = "roles.manage", "Manage roles",
        "Make, change and delete custom roles (from capabilities you hold).";
    SettingsManage = "settings.manage", "Site settings",
        "The Settings page: site-wide defaults, quotas, print rules and policies.";
    GroupsManageAll = "groups.manage_all", "Manage every group",
        "Everything a group's manager can do, in every group, plus top-level groups, moving groups and listing them on the sign-in page.";
    LibraryViewAll = "library.view_all", "See every job",
        "Every job, project and print, whoever made it.";
    LibraryEditAll = "library.edit_all", "Edit every job",
        "Move, rename and delete any job or project.";
    PrintersManage = "printers.manage", "Manage printers",
        "Add, change and remove printers and pools; see connection details; resolve equipment reports.";
    PrintersOperate = "printers.operate", "Operate every printer",
        "Control any printer and print, run the whole queue, set send modes and plate projects.";
    PrintsApprove = "prints.approve", "Approve prints",
        "Approve or turn down any print waiting for approval (not G-code safety reviews).";
    PrintsApproveSafety = "prints.approve_safety", "Review G-code",
        "Send and approve prints whose G-code needs a safety review.";
    PrintsUnrestricted = "prints.unrestricted", "No print rules",
        "Not held to print rules (length, materials) or the upload policy.";
    GcodeCustom = "gcode.custom", "Custom G-code",
        "Use G-code settings in overrides and custom profiles.";
    FeedbackTriage = "feedback.triage", "Triage feedback",
        "Every feedback report and error, and changing their status.";
    IntegrationsManage = "integrations.manage", "Manage integrations",
        "Webhooks, every integration key and every group's usage report.";
    ReportsView = "reports.view", "Reports",
        "The Reports page: what the Slice page proposed against what jobs were made with.";
    AuditView = "audit.view", "Audit log",
        "Who changed accounts, roles, groups and settings, and who decided approvals.";
});

capabilities!(GroupCap {
    Members = "members", "Members",
        "Add, approve and remove members and set their roles (up to your own).";
    Settings = "settings", "Settings",
        "Name, description, settings and logo of the group and its subgroups.";
    Subgroups = "subgroups", "Subgroups",
        "Create subgroups.";
    Links = "links", "Join links",
        "Make and turn off join links.";
    Govern = "govern", "Govern subgroups",
        "Set quotas and delete groups below this one (never this group's own).";
    LibraryView = "library.view", "See the library",
        "Every job and project charged to the group, shared library or not.";
    LibraryEdit = "library.edit", "Edit the library",
        "Move, rename and delete the group's jobs and projects.";
    PrintsApprove = "prints.approve", "Approve prints",
        "Approve or turn down the group's prints waiting for approval.";
    PrintsControl = "prints.control", "Control prints",
        "Pause, resume and stop the group's prints and manage its queued plates.";
    PrintsUnrestricted = "prints.unrestricted", "No print rules",
        "Not held to the group's print rules or upload policy.";
    Integrations = "integrations", "Integrations",
        "The group's integration keys and usage report.";
});

/// A set of capabilities of one kind.
pub struct Caps<C: Capability> {
    bits: u32,
    _kind: PhantomData<C>,
}

impl<C: Capability> Clone for Caps<C> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<C: Capability> Copy for Caps<C> {}
impl<C: Capability> PartialEq for Caps<C> {
    fn eq(&self, other: &Self) -> bool {
        self.bits == other.bits
    }
}
impl<C: Capability> Default for Caps<C> {
    fn default() -> Self {
        Self::none()
    }
}
impl<C: Capability + std::fmt::Debug> std::fmt::Debug for Caps<C> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.ids()).finish()
    }
}

impl<C: Capability> Caps<C> {
    pub const fn none() -> Self {
        Caps { bits: 0, _kind: PhantomData }
    }
    pub fn all() -> Self {
        C::ALL.iter().fold(Self::none(), |s, c| s.with(*c))
    }
    pub fn with(mut self, c: C) -> Self {
        self.bits |= c.bit();
        self
    }
    pub fn has(&self, c: C) -> bool {
        self.bits & c.bit() != 0
    }
    pub fn union(self, other: Self) -> Self {
        Caps { bits: self.bits | other.bits, _kind: PhantomData }
    }
    pub fn is_subset_of(&self, other: &Self) -> bool {
        self.bits & !other.bits == 0
    }
    pub fn is_empty(&self) -> bool {
        self.bits == 0
    }
    pub fn ids(&self) -> Vec<&'static str> {
        C::ALL.iter().filter(|c| self.has(**c)).map(|c| c.id()).collect()
    }
    /// From stored ids; unknown ones (a capability since removed) are
    /// dropped.
    pub fn from_ids<S: AsRef<str>>(ids: &[S]) -> Self {
        ids.iter().filter_map(|i| C::from_id(i.as_ref())).fold(Self::none(), |s, c| s.with(c))
    }
    /// From ids sent by a client: every one must exist.
    pub fn parse<S: AsRef<str>>(ids: &[S]) -> Result<Self, String> {
        ids.iter().try_fold(Self::none(), |s, i| {
            C::from_id(i.as_ref()).map(|c| s.with(c)).ok_or_else(|| format!("no capability '{}'", i.as_ref()))
        })
    }
}

pub type SiteCaps = Caps<Cap>;
pub type GroupCaps = Caps<GroupCap>;

/// Built-in role ids.
pub const OWNER: &str = "owner";
pub const ADMIN: &str = "admin";
pub const USER: &str = "user";
pub const MANAGER: &str = "manager";
pub const MEMBER: &str = "member";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    Site,
    Group,
}

impl Scope {
    pub fn parse(s: &str) -> Option<Scope> {
        match s {
            "site" => Some(Scope::Site),
            "group" => Some(Scope::Group),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Site => "site",
            Scope::Group => "group",
        }
    }
}

/// A role as stored (custom) or defined here (built in).
#[derive(Debug, Clone, Serialize)]
pub struct Role {
    pub id: String,
    pub name: String,
    pub scope: Scope,
    pub description: String,
    pub caps: Vec<String>,
    pub builtin: bool,
    pub created_at: Option<String>,
}

fn builtin(id: &str, name: &str, scope: Scope, description: &str, caps: Vec<&'static str>) -> Role {
    Role {
        id: id.into(),
        name: name.into(),
        scope,
        description: description.into(),
        caps: caps.into_iter().map(String::from).collect(),
        builtin: true,
        created_at: None,
    }
}

pub fn builtin_roles() -> Vec<Role> {
    vec![
        builtin(OWNER, "Owner", Scope::Site, "Everything, and the only one who can change the owner.", SiteCaps::all().ids()),
        builtin(ADMIN, "Admin", Scope::Site, "Everything except changing the owner.", SiteCaps::all().ids()),
        builtin(USER, "User", Scope::Site, "Slices, prints and joins groups; nothing site-wide.", Vec::new()),
        builtin(MANAGER, "Manager", Scope::Group, "Everything in the group and the groups below it.", GroupCaps::all().ids()),
        builtin(
            MEMBER,
            "Member",
            Scope::Group,
            "Slices and prints for the group; sees its library when the group shares it.",
            Vec::new(),
        ),
    ]
}

pub fn is_builtin(id: &str) -> bool {
    matches!(id, OWNER | ADMIN | USER | MANAGER | MEMBER)
}

/// A site role's capabilities. Unknown roles have none.
pub fn site_caps(db: &Db, role: &str) -> SiteCaps {
    match role {
        OWNER | ADMIN => SiteCaps::all(),
        USER => SiteCaps::none(),
        id => db
            .get_role(id)
            .filter(|r| r.scope == Scope::Site)
            .map(|r| SiteCaps::from_ids(&r.caps))
            .unwrap_or_default(),
    }
}

/// Every group role's capabilities, by id (one query per request).
pub fn group_role_caps(db: &Db) -> HashMap<String, GroupCaps> {
    let mut out: HashMap<String, GroupCaps> = db
        .list_roles()
        .into_iter()
        .filter(|r| r.scope == Scope::Group)
        .map(|r| (r.id, GroupCaps::from_ids(&r.caps)))
        .collect();
    out.insert(MANAGER.into(), GroupCaps::all());
    out.insert(MEMBER.into(), GroupCaps::none());
    out
}

/// Every role, built-in first.
pub fn all_roles(db: &Db) -> Vec<Role> {
    let mut out = builtin_roles();
    out.extend(db.list_roles());
    out
}

pub fn role(db: &Db, id: &str) -> Option<Role> {
    builtin_roles().into_iter().find(|r| r.id == id).or_else(|| db.get_role(id))
}

/// The capability lists, for the roles editor.
pub fn catalogue() -> serde_json::Value {
    fn list<C: Capability>() -> Vec<serde_json::Value> {
        C::ALL
            .iter()
            .map(|c| serde_json::json!({"id": c.id(), "label": c.label(), "description": c.description()}))
            .collect()
    }
    serde_json::json!({"site": list::<Cap>(), "group": list::<GroupCap>()})
}

/// May an account with `actor_role` / `actor` act on one whose site role is
/// `target_role` (edit, suspend, delete, give a role)? Owners only by the
/// owner; anyone else by holders of every capability they have.
pub fn outranks(db: &Db, actor_role: &str, actor: SiteCaps, target_role: &str) -> bool {
    if actor_role == OWNER {
        return true;
    }
    if target_role == OWNER {
        return false;
    }
    site_caps(db, target_role).is_subset_of(&actor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_fit() {
        assert!(Cap::ALL.len() <= 32 && GroupCap::ALL.len() <= 32);
        let mut ids: Vec<_> = Cap::ALL.iter().map(|c| c.id()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), Cap::ALL.len());
        let mut ids: Vec<_> = GroupCap::ALL.iter().map(|c| c.id()).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), GroupCap::ALL.len());
    }

    #[test]
    fn sets() {
        let a = SiteCaps::none().with(Cap::UsersView).with(Cap::PrintersManage);
        assert!(a.has(Cap::UsersView) && !a.has(Cap::UsersManage));
        assert!(SiteCaps::none().with(Cap::UsersView).is_subset_of(&a));
        assert!(!SiteCaps::all().is_subset_of(&a));
        assert_eq!(SiteCaps::from_ids(&a.ids()), a);
        assert_eq!(SiteCaps::from_ids(&["users.view", "gone.away"]), SiteCaps::none().with(Cap::UsersView));
        assert!(SiteCaps::parse(&["users.view", "gone.away"]).is_err());
        assert_eq!(GroupCaps::parse(&["members"]).unwrap(), GroupCaps::none().with(GroupCap::Members));
    }
}
