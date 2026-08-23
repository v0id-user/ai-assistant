import { getOwnerId } from "@/lib/identity";
import { getCurrentSessionId } from "@/lib/sessions";
import { getTraces, type Trace } from "@/lib/traces";

// Reads Redis on every request; nothing here should be prerendered.
export const dynamic = "force-dynamic";

const STAGE_ORDER = [
  "memory_load",
  "llm_round_0",
  "tools_round_0",
  "llm_round_1",
  "tools_round_1",
  "llm_final",
];

function stageCells(trace: Trace) {
  const byName = new Map(trace.timings.stages.map((s) => [s.name, s.deltaMs]));
  // Show the known stages in pipeline order, then anything unexpected.
  const extra = trace.timings.stages
    .map((s) => s.name)
    .filter((n) => !STAGE_ORDER.includes(n));
  return [...STAGE_ORDER, ...extra]
    .filter((name) => byName.has(name))
    .map((name) => `${name} ${byName.get(name)}ms`);
}

export default async function Traces() {
  let traces: Trace[] = [];
  let error = "";

  try {
    // Server Components cannot set cookies, so a browser that has not made a
    // request yet simply has nothing to show.
    const ownerId = await getOwnerId();
    if (ownerId) {
      traces = await getTraces(await getCurrentSessionId(ownerId));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-8">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">Traces</h1>
          <p className="text-sm text-muted">
            Last {traces.length} turns of your current session, newest first.
          </p>
        </div>
        <a
          href="/_debug/traces"
          className="rounded-full bg-clay px-4 py-2 text-sm text-cream hover:bg-clay-dark"
        >
          Refresh
        </a>
      </header>

      {error && (
        <p className="rounded border border-sand bg-shell p-3 text-sm">{error}</p>
      )}

      {!error && traces.length === 0 && (
        <p className="text-sm text-muted">
          No traces for this session yet. Have a conversation, then refresh.
        </p>
      )}

      {traces.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-sand text-left align-bottom">
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Said</th>
                <th className="py-2 pr-4 font-medium">Replied</th>
                <th className="py-2 pr-4 font-medium">Total</th>
                <th className="py-2 font-medium">Stages</th>
              </tr>
            </thead>
            <tbody>
              {traces.map((trace, i) => (
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
      )}
    </main>
  );
}
