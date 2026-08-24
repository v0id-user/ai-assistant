"use client";

import { useState } from "react";

// Clipboard access needs the browser, so this small piece is a client
// component; the markdown itself is built on the server.
export function CopyButton({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(markdown);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded border border-sand px-4 py-2 text-sm hover:bg-shell"
    >
      {copied ? "Copied" : "Copy markdown"}
    </button>
  );
}
