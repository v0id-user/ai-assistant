// Stage-boundary timing. Both routes mark the same way so the logs line up.

export type Stage = { name: string; atMs: number; deltaMs: number };

export function createTimer(label: string) {
  const start = performance.now();
  let last = start;
  const stages: Stage[] = [];

  return {
    mark(name: string) {
      const now = performance.now();
      stages.push({
        name,
        atMs: +(now - start).toFixed(1),
        deltaMs: +(now - last).toFixed(1),
      });
      last = now;
    },
    done() {
      const totalMs = +(performance.now() - start).toFixed(1);
      console.log(
        `[${label}] total=${totalMs}ms ` +
          stages.map((s) => `${s.name}=+${s.deltaMs}ms`).join(" "),
      );
      return { totalMs, stages };
    },
  };
}
