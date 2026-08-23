"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

type Turn = { role: "user" | "assistant"; text: string };

type Timings = { totalMs: number; stages: { name: string; deltaMs: number }[] };

// The routes already mark every stage boundary; this just picks them back out
// so the client log can show them separately instead of one collapsed number.
function stage(timings: Timings | undefined, prefix: string): number {
  if (!timings) return 0;
  return timings.stages
    .filter((s) => s.name.startsWith(prefix))
    .reduce((total, s) => total + s.deltaMs, 0);
}

function ms(value: number): string {
  return `${value.toFixed(1)}ms`;
}

// Every browser records something different, and Groq accepts all of them, so
// probe rather than assume. Safari below 18.4 has no webm and needs mp4;
// Firefox has no mp4. Order is best-compressed first.
const MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
}

// Groq reads the container off the filename, so it has to match what we recorded.
function extensionFor(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "mp4";
  return "bin";
}

// Reads the browser environment rather than React state, and never changes.
const neverChanges = () => () => {};

function useRecordingSupported() {
  return useSyncExternalStore(
    neverChanges,
    () => Boolean(navigator.mediaDevices?.getUserMedia) && !!pickMimeType(),
    () => true,
  );
}

type SessionSummary = { sessionId: string; at: number; preview: string };

export default function Home() {
  const supported = useRecordingSupported();

  // The server decides which session this browser is in, via an httpOnly
  // cookie. The client never holds or sends a session id of its own.
  const [sessionId, setSessionId] = useState("");

  const [recording, setRecording] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [facts, setFacts] = useState<string[]>([]);
  const [showFacts, setShowFacts] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Server-shaped message log, replayed each turn for in-session history.
  const historyRef = useRef<unknown[]>([]);

  const loadSessions = useCallback(async () => {
    const res = await fetch("/api/sessions");
    if (!res.ok) return;
    const { sessions } = await res.json();
    setSessions(sessions);
  }, []);

  // Both switching and starting a session are server decisions; the response
  // says which session we ended up in.
  const applySession = useCallback(
    (data: { sessionId: string; turns: Turn[]; facts: string[] }) => {
      setSessionId(data.sessionId);
      setTurns(data.turns);
      setFacts(data.facts);
      setStatus("");
      historyRef.current = data.turns.map((t) => ({
        role: t.role,
        content: t.text,
      }));
    },
    [],
  );

  const loadSession = useCallback(
    async (id: string) => {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id }),
      });
      if (!res.ok) return;
      applySession(await res.json());
    },
    [applySession],
  );

  const newSession = useCallback(async () => {
    const res = await fetch("/api/session", { method: "POST" });
    if (!res.ok) return;
    applySession(await res.json());
    void loadSessions();
  }, [applySession, loadSessions]);

  // Populate the panels on load. setState happens in the async callback, not
  // synchronously in the effect body.
  useEffect(() => {
    void fetch("/api/sessions")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setSessions(d.sessions));
  }, []);

  useEffect(() => {
    void fetch("/api/session")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setSessionId(d.sessionId);
        setTurns(d.turns);
        setFacts(d.facts);
        historyRef.current = d.turns.map((t: Turn) => ({
          role: t.role,
          content: t.text,
        }));
      });
  }, []);

  const failure = async (res: Response, label: string) => {
    const body = await res.json().catch(() => null);
    return new Error(body?.error ?? `${label} failed: ${res.status}`);
  };

  const respond = useCallback(
    async (clip: Blob, mimeType: string, startedAt: number) => {
      setStatus("Transcribing…");

      const form = new FormData();
      form.append("audio", clip, `speech.${extensionFor(mimeType)}`);

      const sttRes = await fetch("/api/stt", { method: "POST", body: form });
      if (!sttRes.ok) throw await failure(sttRes, "Transcription");
      const { text: transcript, timings: sttTimings } = await sttRes.json();
      const tStt = performance.now();

      if (!transcript) {
        setStatus("Didn't catch that.");
        return;
      }

      setTurns((prev) => [...prev, { role: "user", text: transcript }]);
      setStatus("Thinking…");

      const chatRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript, history: historyRef.current }),
      });
      if (!chatRes.ok) throw await failure(chatRes, "Chat");
      const { text, messages, timings: chatTimings } = await chatRes.json();

      historyRef.current = messages;
      setTurns((prev) => [...prev, { role: "assistant", text }]);
      setStatus("Speaking…");

      const ttsRes = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!ttsRes.ok) throw await failure(ttsRes, "Speech");

      const ttsTimings: Timings | undefined = JSON.parse(
        ttsRes.headers.get("X-Timings") ?? "null",
      );
      const blob = await ttsRes.blob();
      const tTts = performance.now();

      const url = URL.createObjectURL(blob);
      const audio = audioRef.current!;
      audio.src = url;
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
      const tPlay = performance.now();

      // Upload and response overhead: whatever the round trip cost beyond the
      // work the server actually reported doing.
      const sttOverhead = tStt - startedAt - stage(sttTimings, "transcribe");

      console.log(
        [
          "[client]",
          `stt=+${ms(stage(sttTimings, "transcribe"))}`,
          `upload=+${ms(sttOverhead)}`,
          `memory_load=+${ms(stage(chatTimings, "memory_load"))}`,
          `llm_complete=+${ms(stage(chatTimings, "llm_"))}`,
          `tools=+${ms(stage(chatTimings, "tools_"))}`,
          `tts_first_byte=+${ms(stage(ttsTimings, "tts_first_byte"))}`,
          `tts_complete=+${ms(stage(ttsTimings, "tts_complete"))}`,
          `playback=+${ms(tPlay - tTts)}`,
          `total=${ms(tPlay - startedAt)}`,
        ].join(" "),
      );
      setStatus("");

      // Bookkeeping is written after the response, so re-read once it lands.
      setTimeout(() => {
        void loadSessions();
        void fetch("/api/session")
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => d && setFacts(d.facts));
      }, 400);
    },
    [loadSessions],
  );

  const start = async () => {
    setStatus("");
    const mimeType = pickMimeType();
    if (!mimeType) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };

      recorder.onstop = async () => {
        // Release the mic as soon as we have the audio, so the browser stops
        // showing the recording indicator while the request is in flight.
        stream.getTracks().forEach((track) => track.stop());
        const stoppedAt = performance.now();
        try {
          await respond(new Blob(chunks, { type: mimeType }), mimeType, stoppedAt);
        } catch (err) {
          setStatus(err instanceof Error ? err.message : String(err));
        }
      };

      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  };

  return (
    <>
      <aside className="fixed top-4 left-4 hidden w-56 rounded border border-sand bg-shell/70 p-3 text-sm xl:block">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="font-medium">Sessions</span>
          <button
            onClick={() => void loadSessions()}
            className="text-xs text-muted hover:text-ink"
          >
            reload
          </button>
        </div>
        {sessions.length === 0 ? (
          <p className="text-xs text-muted">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {sessions.map((s) => (
              <li key={s.sessionId}>
                <button
                  onClick={() => void loadSession(s.sessionId)}
                  className={`w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-sand ${
                    s.sessionId === sessionId ? "bg-sand font-medium" : ""
                  }`}
                  title={s.preview}
                >
                  {s.preview}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Sarjy</h1>
          <p className="text-sm text-muted">
            Talk to it. It remembers, and it knows the weather.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => setShowFacts((v) => !v)}
            className="rounded border border-sand px-3 py-1.5 text-sm hover:bg-shell"
          >
            Facts ({facts.length})
          </button>
          <button
            onClick={() => void newSession()}
            className="rounded border border-sand px-3 py-1.5 text-sm hover:bg-shell"
          >
            New session
          </button>
        </div>
      </header>

      {showFacts && (
        <div className="rounded border border-sand bg-shell p-3 text-sm">
          <p className="mb-1 font-medium">Remembered about you</p>
          {facts.length === 0 ? (
            <p className="text-muted">
              Nothing yet. Tell Sarjy something about yourself.
            </p>
          ) : (
            <ul className="list-inside list-disc">
              {facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">session {sessionId.slice(0, 8)}</p>
        </div>
      )}

      {!supported && (
        <p className="rounded border border-sand bg-shell p-3 text-sm text-ink">
          This browser cannot record audio. Use a current desktop browser.
        </p>
      )}

      <button
        onClick={recording ? stop : start}
        disabled={!supported || !sessionId}
        className={`self-start rounded-full px-6 py-3 text-cream transition disabled:opacity-40 ${
          recording ? "bg-rust hover:bg-rust" : "bg-clay hover:bg-clay-dark"
        }`}
      >
        {recording ? "Stop" : "Talk"}
      </button>

      <div className="min-h-6 text-sm text-muted">{status}</div>

      <ol className="flex flex-col gap-3">
        {turns.map((turn, i) => (
          <li
            key={i}
            className={
              turn.role === "user"
                ? "self-end rounded-lg bg-shell px-4 py-2"
                : "self-start rounded-lg border border-sand bg-cream px-4 py-2"
            }
          >
            {turn.text}
          </li>
        ))}
      </ol>

        <audio ref={audioRef} hidden />
      </main>
    </>
  );
}
