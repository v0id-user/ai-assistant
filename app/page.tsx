"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

type Turn = { role: "user" | "assistant"; text: string };

// Both of these read the browser environment rather than React state, which is
// what useSyncExternalStore is for. Neither ever changes, so nothing subscribes.
const neverChanges = () => () => {};

// One id per browser session, persisted so memory survives a reload.
function useSessionId() {
  return useSyncExternalStore(
    neverChanges,
    () => {
      let id = localStorage.getItem("sarjy:sessionId");
      if (!id) {
        id = crypto.randomUUID();
        localStorage.setItem("sarjy:sessionId", id);
      }
      return id;
    },
    () => "",
  );
}

function useSpeechSupported() {
  return useSyncExternalStore(
    neverChanges,
    () => Boolean(window.SpeechRecognition ?? window.webkitSpeechRecognition),
    () => true,
  );
}

export default function Home() {
  const sessionId = useSessionId();

  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [status, setStatus] = useState("");
  const supported = useSpeechSupported();

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Server-shaped message log, replayed each turn for in-session history.
  const historyRef = useRef<unknown[]>([]);

  const respond = useCallback(
    async (transcript: string) => {
      const t0 = performance.now();
      setTurns((prev) => [...prev, { role: "user", text: transcript }]);
      setStatus("Thinking…");

      try {
        const chatRes = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript,
            sessionId,
            history: historyRef.current,
          }),
        });
        if (!chatRes.ok) throw new Error(`Chat failed: ${chatRes.status}`);
        const { text, messages, timings } = await chatRes.json();

        const tLlm = performance.now();
        historyRef.current = messages;
        setTurns((prev) => [...prev, { role: "assistant", text }]);
        setStatus("Speaking…");

        const ttsRes = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!ttsRes.ok) throw new Error(`TTS failed: ${ttsRes.status}`);

        const blob = await ttsRes.blob();
        const tTts = performance.now();

        const url = URL.createObjectURL(blob);
        const audio = audioRef.current!;
        audio.src = url;
        audio.onended = () => URL.revokeObjectURL(url);
        await audio.play();
        const tPlay = performance.now();

        console.log(
          `[client] llm=+${(tLlm - t0).toFixed(1)}ms ` +
            `tts=+${(tTts - tLlm).toFixed(1)}ms ` +
            `playback=+${(tPlay - tTts).toFixed(1)}ms ` +
            `total=${(tPlay - t0).toFixed(1)}ms`,
          timings,
        );
        setStatus("");
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      }
    },
    [sessionId],
  );

  useEffect(() => {
    const Recognition =
      typeof window !== "undefined"
        ? window.SpeechRecognition ?? window.webkitSpeechRecognition
        : undefined;

    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let partial = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          setInterim("");
          void respond(result[0].transcript.trim());
        } else {
          partial += result[0].transcript;
        }
      }
      setInterim(partial);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      setStatus(`Mic error: ${event.error}`);
      setListening(false);
    };
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    return () => recognition.abort();
  }, [respond]);

  const toggle = () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (listening) {
      recognition.stop();
    } else {
      setStatus("");
      setInterim("");
      recognition.start();
      setListening(true);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Sarjy</h1>
        <p className="text-sm text-gray-500">
          Talk to it. It remembers, and it knows the weather.
        </p>
      </header>

      {!supported && (
        <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          This browser has no Web Speech API. Use Chrome or Edge on desktop.
        </p>
      )}

      <button
        onClick={toggle}
        disabled={!supported || !sessionId}
        className={`self-start rounded-full px-6 py-3 text-white transition disabled:opacity-40 ${
          listening ? "bg-red-600 hover:bg-red-700" : "bg-black hover:bg-gray-800"
        }`}
      >
        {listening ? "Stop" : "Talk"}
      </button>

      <div className="min-h-6 text-sm text-gray-500">
        {interim || status}
      </div>

      <ol className="flex flex-col gap-3">
        {turns.map((turn, i) => (
          <li
            key={i}
            className={
              turn.role === "user"
                ? "self-end rounded-lg bg-gray-100 px-4 py-2"
                : "self-start rounded-lg bg-blue-50 px-4 py-2"
            }
          >
            {turn.text}
          </li>
        ))}
      </ol>

      <audio ref={audioRef} hidden />
    </main>
  );
}
