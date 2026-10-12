/** Shows a freshly issued recovery (or guest sign-in) code once and waits for acknowledgement. */
export default function RecoveryCode({
  code,
  onDone,
  intro,
  title = "Save your recovery code.",
}: {
  code: string;
  onDone: () => void;
  intro?: string;
  title?: string;
}) {
  return (
    <div className="card api-key-reveal">
      <p>
        <strong>{title}</strong>{" "}
        {intro ??
          "If you ever lose every passkey for this account, this code lets you enrol a new one. It is shown only now."}
      </p>
      <code className="api-key-value">{code}</code>
      <p>
        <button className="btn-primary" onClick={onDone}>
          I have saved it
        </button>
      </p>
    </div>
  );
}
