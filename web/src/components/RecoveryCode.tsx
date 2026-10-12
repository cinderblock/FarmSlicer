/** Shows a freshly issued recovery code once and waits for acknowledgement. */
export default function RecoveryCode({
  code,
  onDone,
  intro,
}: {
  code: string;
  onDone: () => void;
  intro?: string;
}) {
  return (
    <div className="card api-key-reveal">
      <p>
        <strong>Save your recovery code.</strong>{" "}
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
