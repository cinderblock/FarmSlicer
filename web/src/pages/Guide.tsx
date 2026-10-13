import { Link } from "react-router";
import { useJson } from "../api";
import { describeRules, type Printer, type PrintRules } from "../printers";

interface GuideInfo {
  /** The farm's own notes (Settings), plain text. */
  notes: string;
  /** The default print rules (groups may set their own). */
  print_rules: PrintRules;
}

/** Plain text → paragraphs and lines, with bare URLs as links. */
function Notes({ text }: { text: string }) {
  const link = (line: string, key: number) =>
    line.split(/(https?:\/\/\S+)/g).map((part, i) =>
      /^https?:\/\//.test(part) ? (
        <a key={`${key}-${i}`} href={part} target="_blank" rel="noreferrer">
          {part}
        </a>
      ) : (
        part
      ),
    );
  return (
    <>
      {text
        .split(/\n\s*\n/)
        .filter((p) => p.trim())
        .map((para, i) => (
          <p key={i}>
            {para.split("\n").map((line, j) => (
              <span key={j}>
                {j > 0 && <br />}
                {link(line, j)}
              </span>
            ))}
          </p>
        ))}
    </>
  );
}

/** /guide: how printing works here. */
export default function GuidePage() {
  const info = useJson<GuideInfo>("/api/guide").data;
  const printers = useJson<Printer[]>("/api/printers").data ?? [];
  const models = [...new Set(printers.map((p) => `${p.machine_profile}, ${p.nozzle_diameter} mm nozzle`))].sort();

  return (
    <div className="page guide">
      <h2>How to print</h2>

      {info?.notes && (
        <section className="card guide-notes">
          <h3>From the farm</h3>
          <Notes text={info.notes} />
        </section>
      )}

      <section>
        <h3>The printers</h3>
        {models.length > 0 ? (
          <ul>
            {models.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : (
          <p className="hint">No printers are set up yet.</p>
        )}
        <p>
          The <Link to="/">Printers</Link> page shows which are free and what filament each has loaded.
          {info && (
            <>
              {" "}
              Prints are sent straight away if they stay within the rules ({describeRules(info.print_rules)}
              ; your group may have its own); otherwise they wait for an admin or a manager of your group to
              approve them.
            </>
          )}
        </p>
      </section>

      <section>
        <h3>1. Get a sliced plate</h3>
        <p>Either way works:</p>
        <h4>Slice here</h4>
        <ol>
          <li>
            On <Link to="/slice">Slice</Link>, drop in your model (STL, 3MF, OBJ or STEP).
          </li>
          <li>Pick a printer, or a model and nozzle, then the print quality and the filament.</li>
          <li>Press Slice. It runs on the server or in your browser and shows up on Jobs when done.</li>
        </ol>
        <h4>Or slice in Bambu Studio / OrcaSlicer</h4>
        <ol>
          <li>
            Install{" "}
            <a href="https://bambulab.com/en/download/studio" target="_blank" rel="noreferrer">
              Bambu Studio
            </a>{" "}
            or{" "}
            <a href="https://github.com/SoftFever/OrcaSlicer/releases" target="_blank" rel="noreferrer">
              OrcaSlicer
            </a>
            .
          </li>
          <li>Choose one of the printers above (model and nozzle size) and the build plate type.</li>
          <li>Choose a filament that is loaded in the printer you want (see Printers).</li>
          <li>Slice, then export the plate: File → Export → Export plate sliced file (a .gcode.3mf).</li>
          <li>
            On <Link to="/jobs">Jobs</Link>, press "Upload a sliced file" and pick it.
          </li>
        </ol>
      </section>

      <section>
        <h3>2. Send it to a printer</h3>
        <ol>
          <li>On Jobs, press Print… next to the job.</li>
          <li>Pick a free printer that fits the plate (the list says why others don't).</li>
          <li>Check which tray each filament will come from; change it if needed.</li>
          <li>Press Print. Upload and start take a few seconds.</li>
        </ol>
      </section>

      <section>
        <h3>3. While it prints</h3>
        <p>
          <Link to="/prints">Prints</Link> lists your prints; the printer's card shows progress, the camera,
          and lets you pause or stop it.
        </p>
      </section>

      <section>
        <h3>4. When it's done</h3>
        <ul>
          <li>Let the plate cool, then take it out and remove your print.</li>
          <li>
            Don't touch the printing surface with bare hands: skin oils stop prints sticking. If you do, clean
            it with isopropyl alcohol (or warm water and dish soap) and dry it.
          </li>
          <li>Put the plate back, clean, for the next person.</li>
          <li>
            Something wrong with a printer? Use "Report a problem" on its card so an admin sees it.
          </li>
        </ul>
      </section>
    </div>
  );
}
