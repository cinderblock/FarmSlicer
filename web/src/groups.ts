// Types shared by the group, join, account and admin pages (see
// src/groups.rs, src/quota.rs and src/join_api.rs on the server).

export interface GroupSummary {
  id: string;
  parent_id: string | null;
  name: string;
  /** "Parent / Child / Group" */
  path: string;
  description: string;
  self_key: string | null;
  member_count: number;
  my_role: "member" | "manager" | null;
  my_status: "active" | "pending" | null;
  can_manage: boolean;
  created_at: string;
}

export interface SubgroupPolicy {
  mode: "none" | "choose" | "self_service";
  required: boolean;
  label: string;
  pattern: string;
  name_template: string;
  creator_becomes_manager: boolean;
}

/** Stored settings: absent keys are inherited. */
export interface GroupSettings {
  season_start?: string;
  /** Thumbnail label template: {key} = the nearest group's identifier, {group} = its name. "" = none. */
  thumbnail_label?: string;
  /** Limits on prints without approval; inherited as a whole. */
  print_rules?: import("./printers").PrintRules;
  shared_library?: boolean;
  keep_models?: boolean;
  allow_guests?: boolean;
  allow_registration?: boolean;
  join_policy?: "open" | "approval";
  /** Pre-sliced uploads; inherited. */
  uploads?: import("./printers").UploadPolicy;
  listed?: boolean;
  subgroups?: SubgroupPolicy;
}

export interface EffectiveSettings {
  season_start: string;
  thumbnail_label: string;
  print_rules: import("./printers").PrintRules;
  shared_library: boolean;
  keep_models: boolean;
  allow_guests: boolean;
  allow_registration: boolean;
  join_policy: "open" | "approval";
  uploads: import("./printers").UploadPolicy;
  /** Which group each value came from (null = site default). */
  sources: Record<string, string | null>;
}

export interface Rule {
  metric: Metric;
  period: Period;
  limit: number;
}

export interface GroupQuotas {
  pool: Rule[];
  member: Rule[];
  guest?: Rule[];
}

export interface GroupDetail extends GroupSummary {
  settings: GroupSettings;
  effective: EffectiveSettings;
  quotas: GroupQuotas;
  can_govern: boolean;
  is_admin: boolean;
  ancestors: { id: string; name: string }[];
  children: GroupSummary[];
}

export interface Member {
  user_id: string;
  username: string;
  kind: "full" | "guest";
  role: "member" | "manager";
  status: "active" | "pending";
  quotas: Rule[] | null;
  joined_at: string;
}

export interface JoinLink {
  id: string;
  group_id: string;
  code: string;
  url: string;
  public: boolean;
  bypass_approval: boolean;
  label: string;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  disabled: boolean;
  created_at: string;
}

export interface QuotaLine {
  scope: "user" | "member" | "pool";
  group_id: string | null;
  group_name: string | null;
  metric: Metric;
  period: Period;
  since: string;
  limit: number;
  used: number;
}

export interface LibraryJob {
  id: string;
  model_name: string;
  status: string;
  source: "server" | "browser";
  created_at: string;
  username: string | null;
  group_id: string | null;
  group_name: string | null;
  print_time_sec: number | null;
  filament_used_g: number | null;
  has_model: boolean;
  slice_id: string | null;
  season: number;
}

export interface GroupLibrary {
  season_start: string;
  current_season: number;
  seasons: { year: number; label: string; current: boolean }[];
  jobs: LibraryJob[];
}

export type Metric = "slices" | "filament_g" | "print_hours" | "storage_mb";
export type Period = "day" | "week" | "month" | "season" | "total";

export const METRICS: { value: Metric; label: string; unit: string }[] = [
  { value: "slices", label: "Slices", unit: "" },
  { value: "filament_g", label: "Filament", unit: "g" },
  { value: "print_hours", label: "Print time", unit: "h" },
  { value: "storage_mb", label: "Storage", unit: "MB" },
];

export const PERIODS: { value: Period; label: string }[] = [
  { value: "day", label: "per day" },
  { value: "week", label: "per week" },
  { value: "month", label: "per month" },
  { value: "season", label: "per season" },
  { value: "total", label: "in total" },
];

export function metricLabel(m: Metric): string {
  return METRICS.find((x) => x.value === m)?.label ?? m;
}

export function formatAmount(m: Metric, n: number): string {
  const unit = METRICS.find((x) => x.value === m)?.unit ?? "";
  const rounded = m === "slices" ? String(Math.round(n)) : n.toFixed(n < 10 ? 1 : 0);
  return unit ? `${rounded} ${unit}` : rounded;
}

export function ruleText(r: Rule): string {
  const period = r.metric === "storage_mb" ? "in total" : (PERIODS.find((p) => p.value === r.period)?.label ?? r.period);
  return `${metricLabel(r.metric)}: ${formatAmount(r.metric, r.limit)} ${period}`;
}

/** "Filament: 60 g of 500 g per month" */
export function usageText(l: QuotaLine): string {
  const period = l.metric === "storage_mb" ? "in total" : (PERIODS.find((p) => p.value === l.period)?.label ?? l.period);
  return `${metricLabel(l.metric)}: ${formatAmount(l.metric, l.used)} of ${formatAmount(l.metric, l.limit)} ${period}`;
}
