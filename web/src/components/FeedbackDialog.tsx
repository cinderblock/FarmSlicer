import { useEffect, useState } from "react";
import { Link } from "react-router";
import { apiJson } from "../auth";
import { errorText, localDateTime, useJson } from "../api";
import { BUILD_VERSION, diagnostics } from "../errorReporting";
import { feedbackChanged, KINDS, type FeedbackItem, type FeedbackPrefill, type Kind } from "../feedback";
import type { Printer } from "../printers";

interface JobSummary {
  id: string;
  model_name: string;
  status: string;
  created_at: string;
}

const MAX_MESSAGE = 5000;
/** Jobs offered in the picker: the caller's most recent. */
const RECENT_JOBS = 30;

/** The Feedback button's dialog: a category, what happened, optionally a
 *  printer or job, and (by default) diagnostics. */
export default function FeedbackDialog({ prefill, onClose }: { prefill: FeedbackPrefill; onClose: () => void }) {
  const [kind, setKind] = useState<Kind>(prefill.kind ?? "app");
  const [message, setMessage] = useState("");
  const [printerId, setPrinterId] = useState(prefill.printerId ?? "");
  const [jobId, setJobId] = useState(prefill.jobId ?? "");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  // What is sent is what the reporter can look at: taken once, on opening.
  const [snapshot] = useState(diagnostics);
  const [pageUrl] = useState(() => window.location.pathname + window.location.search);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<FeedbackItem | null>(null);

  const askPrinter = kind === "printer" || !!prefill.printerId;
  const askJob = kind === "slicer" || kind === "printer" || kind === "bug" || !!prefill.jobId;
  const printers = useJson<Printer[]>(askPrinter ? "/api/printers" : null).data ?? [];
  const jobs = (useJson<JobSummary[]>(askJob ? "/api/jobs?mine=1" : null).data ?? []).slice(0, RECENT_JOBS);
  const prefilledJobMissing = !!jobId && !jobs.some((j) => j.id === jobId);

  const dirty = message.trim() !== "" && !sent;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (!dirty || window.confirm("Discard this feedback?"))) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, dirty]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSending(true);
    try {
      const item = await apiJson<FeedbackItem>("/api/feedback", "POST", {
        kind,
        message,
        printer_id: askPrinter && printerId ? printerId : null,
        job_id: askJob && jobId ? jobId : null,
        page_url: pageUrl,
        version: BUILD_VERSION,
        context: includeDiagnostics ? snapshot : null,
      });
      setSent(item);
      feedbackChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => !dirty && onClose()}>
      <div className="modal feedback-dialog" role="dialog" aria-label="Send feedback" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Send feedback</h3>
          <button className="btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {sent ? (
          <div className="feedback-sent">
            <p>Thanks, your report reached the admins.</p>
            <p className="hint">
              You can follow it (and any reply) under <Link to="/feedback" onClick={onClose}>My feedback</Link>.
            </p>
            <div className="modal-actions">
              <button className="btn-primary btn-inline" onClick={onClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form className="feedback-form" onSubmit={send}>
            <h4>What is it about?</h4>
            <div className="feedback-kinds" role="radiogroup" aria-label="Category">
              {KINDS.map((k) => (
                <button
                  type="button"
                  key={k.value}
                  role="radio"
                  aria-checked={kind === k.value}
                  className={`feedback-kind ${kind === k.value ? "active" : ""}`}
                  title={k.hint}
                  onClick={() => setKind(k.value)}
                >
                  {k.label}
                </button>
              ))}
            </div>

            {(askPrinter || askJob) && (
              <div className="feedback-refs">
                {askPrinter && (
                  <label>
                    Printer
                    <select value={printerId} onChange={(e) => setPrinterId(e.target.value)}>
                      <option value="">(none)</option>
                      {printers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {askJob && (
                  <label>
                    Job
                    <select value={jobId} onChange={(e) => setJobId(e.target.value)}>
                      <option value="">(none)</option>
                      {prefilledJobMissing && <option value={jobId}>This page's job</option>}
                      {jobs.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.model_name} · {localDateTime(j.created_at)} · {j.status}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}

            <label className="feedback-message">
              What happened? What did you expect?
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={6}
                maxLength={MAX_MESSAGE}
                required
                autoFocus
                placeholder="The more detail, the easier it is to act on."
              />
              {message.length > MAX_MESSAGE - 500 && (
                <span className="hint">
                  {message.length} / {MAX_MESSAGE}
                </span>
              )}
            </label>

            <label className="checkbox-label feedback-diagnostics">
              <input
                type="checkbox"
                checked={includeDiagnostics}
                onChange={(e) => setIncludeDiagnostics(e.target.checked)}
              />
              Include diagnostics: recent console messages, the page address, app version and window size
            </label>
            {includeDiagnostics && (
              <details className="feedback-preview">
                <summary>What's included</summary>
                <pre>{JSON.stringify(snapshot, null, 2)}</pre>
              </details>
            )}

            {error && <p className="printer-error">{error}</p>}
            <div className="modal-actions">
              <Link to="/feedback" className="link-button feedback-mine" onClick={onClose}>
                My feedback
              </Link>
              <button type="button" className="btn-sm" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn-primary btn-inline" disabled={sending || message.trim() === ""}>
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
