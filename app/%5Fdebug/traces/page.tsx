import { getOwnerId } from "@/lib/identity";
import { CopyButton } from "./copy-button";
import { getTracesForOwner, type Trace } from "@/lib/traces";

// Reads Redis on every request; nothing here should be prerendered.
export const dynamic = "force-dynamic";

function stageCells(trace: Trace) {
  // Stages are recorded in the order they happened and now carry descriptive
  // names, so no reordering is needed.
  return trace.timings.stages.map((s) => `${s.name} ${s.deltaMs}ms`);
}

function toolCells(trace: Trace) {
  return (trace.tools ?? []).map(
    (t) => `${t.name}(${t.args.replace(/[{}"]/g, "")})`,
  );
}

// Newest session first, turns newest first within each.
function groupBySession(traces: Trace[]) {
  const groups = new Map<string, Trace[]>();
  for (const trace of traces) {
    const list = groups.get(trace.sessionId) ?? [];
    list.push(trace);
    groups.set(trace.sessionId, list);
  }
  return [...groups.entries()];
}

function toMarkdown(groups: [string, Trace[]][]) {
  return groups
    .map(([sessionId, rows]) => {
      const header =
        `## Session ${sessionId}\n\n` +
        `| When | Said | Replied | Total | Tokens | Tools | Stages |\n` +
        `| --- | --- | --- | --- | --- | --- | --- |`;
      const body = rows
        .map((t) =>
          [
            t.at,
            t.transcript.replace(/\|/g, "\\|"),
            t.response.replace(/\|/g, "\\|"),
            `${t.timings.totalMs}ms`,
            t.tokens
              ? `in ${t.tokens.prompt} / out ${t.tokens.completion} / cached ${t.tokens.cached}`
              : "-",
            toolCells(t).join("; ") || "-",
            stageCells(t).join("; "),
          ].join(" | "),
        )
        .map((row) => `| ${row} |`)
        .join("\n");
      return `${header}\n${body}`;
    })
    .join("\n\n");
}

export default async function Traces() {
  let traces: Trace[] = [];
  let error = "";

  try {
    // Server Components cannot set cookies, so a browser that has not made a
    // request yet simply has nothing to show.
    const ownerId = await getOwnerId();
    if (ownerId) {
      traces = await getTracesForOwner(ownerId);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const groups = groupBySession(traces);
  const markdown = toMarkdown(groups);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">Traces</h1>
          <p className="text-sm text-muted">
            {traces.length} turns across {groups.length} session
            {groups.length === 1 ? "" : "s"}, newest first.
          </p>
        </div>
        <div className="flex gap-2">
          <CopyButton markdown={markdown} />
          <a
            href="/_debug/traces"
            className="rounded-full bg-clay px-4 py-2 text-sm text-cream hover:bg-clay-dark"
          >
            Refresh
          </a>
        </div>
      </header>

      {error && (
        <p className="rounded border border-sand bg-shell p-3 text-sm">{error}</p>
      )}

      {!error && traces.length === 0 && (
        <p className="text-sm text-muted">
          No traces yet. Have a conversation, then refresh.
        </p>
      )}

      {groups.map(([sessionId, rows]) => (
        <section key={sessionId} className="flex flex-col gap-2">
          <h2 className="font-mono text-sm text-muted">
            session {sessionId} · {rows.length} turn
            {rows.length === 1 ? "" : "s"}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-sand text-left align-bottom">
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Said</th>
                  <th className="py-2 pr-4 font-medium">Replied</th>
                  <th className="py-2 pr-4 font-medium">Total</th>
                  <th className="py-2 pr-4 font-medium">Tokens</th>
                  <th className="py-2 pr-4 font-medium">Tools</th>
                  <th className="py-2 font-medium">Stages</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((trace, i) => (
                  <tr key={i} className="border-b border-sand/60 align-top">
                    <td className="py-2 pr-4 whitespace-nowrap text-muted">
                      {trace.at.slice(11, 19)}
                      <div className="text-xs">{trace.at.slice(0, 10)}</div>
                    </td>
                    <td className="max-w-xs py-2 pr-4">{trace.transcript}</td>
                    <td className="max-w-xs py-2 pr-4">{trace.response}</td>
                    <td className="py-2 pr-4 whitespace-nowrap font-medium">
                      {trace.timings.totalMs}ms
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs whitespace-nowrap">
                      {trace.tokens ? (
                        <>
                          <div>in {trace.tokens.prompt}</div>
                          <div>out {trace.tokens.completion}</div>
                          <div
                            className={
                              trace.tokens.cached > 0 ? "" : "text-muted"
                            }
                          >
                            cached {trace.tokens.cached}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {trace.tools?.length ? (
                        <div className="flex flex-col gap-1">
                          {trace.tools.map((t, j) => (
                            <span key={j} className="font-mono text-xs">
                              {t.name}({t.args.replace(/[{}"]/g, "")})
                              <span className="block text-muted">
                                → {t.result.replace(/[{}"]/g, "").slice(0, 60)}
                              </span>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {stageCells(trace).map((label) => (
                          <span
                            key={label}
                            className="rounded bg-shell px-2 py-0.5 text-xs whitespace-nowrap"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </main>
  );
}
