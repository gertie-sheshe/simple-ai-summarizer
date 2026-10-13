"use client";

import {useState} from "react";

type Result = {title: string; url: string; summary: string};

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({url}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{maxWidth: 720, margin: "3rem auto", padding: "0 1rem"}}>
      <h1>Website Summarizer</h1>

      <form
        onSubmit={handleSubmit}
        style={{display: "flex", gap: 8, margin: "1rem 0"}}>
        <label htmlFor="url" style={{position: "absolute", left: -9999}}>
          Website URL
        </label>
        <input
          id="url"
          type="url"
          required
          placeholder="https://example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{flex: 1, padding: 8}}
        />
        <button type="submit" disabled={loading} style={{padding: "8px 16px"}}>
          {loading ? "Summarizing..." : "Summarize"}
        </button>
      </form>

      <div aria-live="polite">
        {error && (
          <p role="alert" style={{color: "crimson"}}>
            {error}
          </p>
        )}
        {result && (
          <article>
            <h2>{result.title || result.url}</h2>
            <pre style={{whiteSpace: "pre-wrap", fontFamily: "inherit"}}>
              {result.summary}
            </pre>
          </article>
        )}
      </div>
    </main>
  );
}
