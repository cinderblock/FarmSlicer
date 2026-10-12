import { Link } from "react-router";
import type { GroupSummary } from "../groups";

/** Groups with their path, member count and the viewer's role. */
export default function GroupTable({ groups }: { groups: GroupSummary[] }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Group</th>
          <th>Members</th>
          <th>You</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((c) => (
          <tr key={c.id}>
            <td>
              <Link to={`/groups/${c.id}`}>{c.path}</Link>
              {c.description && <div className="hint">{c.description}</div>}
            </td>
            <td>{c.member_count}</td>
            <td>
              {c.my_role ? `${c.my_role}${c.my_status === "pending" ? " (pending)" : ""}` : c.can_manage ? "manage" : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
