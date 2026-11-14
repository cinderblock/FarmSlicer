// Roles and capabilities (src/permissions.rs, `/api/roles`): what the
// Users, Roles and group pages offer.
import { useJson } from "./api";
import type { GroupCap, SiteCap, User } from "./auth";

export interface Role {
  id: string;
  name: string;
  scope: "site" | "group";
  description: string;
  caps: string[];
  builtin: boolean;
  created_at: string | null;
  /** Accounts (site) or memberships (group) holding it; null for built-in roles. */
  holders: number | null;
}

export interface CapabilityInfo {
  id: string;
  label: string;
  description: string;
}

export interface RolesResponse {
  roles: Role[];
  capabilities: { site: CapabilityInfo[]; group: CapabilityInfo[] };
}

export function useRoles(rev = 0) {
  return useJson<RolesResponse>("/api/roles", rev);
}

/** A role's name by id, falling back to the id. */
export function roleName(roles: Role[] | undefined, id: string): string {
  return roles?.find((r) => r.id === id)?.name ?? id;
}

/** Site roles `me` may give: never the owner's, and none with a capability `me` lacks. */
export function assignableSiteRoles(roles: Role[] | undefined, me: User | null): Role[] {
  const mine = new Set<string>(me?.caps ?? []);
  return (roles ?? []).filter(
    (r) => r.scope === "site" && r.id !== "owner" && (me?.role === "owner" || r.caps.every((c) => mine.has(c as SiteCap))),
  );
}

/** Group roles someone holding `held` in a group may give there (needs "members"). */
export function assignableGroupRoles(roles: Role[] | undefined, held: GroupCap[] | undefined): Role[] {
  const mine = new Set<string>(held ?? []);
  if (!mine.has("members")) return [];
  return (roles ?? []).filter((r) => r.scope === "group" && r.caps.every((c) => mine.has(c)));
}
