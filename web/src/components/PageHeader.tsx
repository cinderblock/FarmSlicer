import type { ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

/** A page's title, what the page is for, and its main actions (right). */
export default function PageHeader({
  title,
  icon,
  children,
  actions,
}: {
  title: ReactNode;
  icon?: IconName;
  /** A sentence or two under the title. */
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div className="page-head-text">
        <h2>
          {icon && (
            <span className="page-head-icon">
              <Icon name={icon} size={20} />
            </span>
          )}
          {title}
        </h2>
        {children && <div className="page-sub">{children}</div>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </header>
  );
}

/** What a list shows when it has nothing in it, and how to change that. */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state empty-rich">
      <span className="empty-icon">
        <Icon name={icon} size={26} strokeWidth={1.6} />
      </span>
      <p className="empty-title">{title}</p>
      {children && <p className="empty-text">{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
