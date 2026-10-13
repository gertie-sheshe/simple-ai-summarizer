# Site Summarizer

A Next.js app that takes a website URL, scrapes the page, and uses Google Gemini to produce a short structured summary.

Built with TypeScript, Next.js (App Router), Node.js, `@google/genai`, `cheerio` and `undici`.

## How it works

1. The UI (`app/page.tsx`) posts `{ "url": "..." }` to `/api/summarize`.
2. `lib/scrape.ts` validates the URL, fetches the HTML safely, and extracts the readable text.
3. `lib/summarize.ts` sends that text to Gemini and returns the summary.
4. The route (`app/api/summarize/route.ts`) maps failures to proper HTTP status codes and logs details server-side with a request ID.

## Getting started

Requirements: Node.js 20 or later and a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey).

```bash
git clone <your-repo-url>
cd site-summarizer
npm install
```

Create `.env.local` in the project root:

```
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.5-flash
```

`GEMINI_MODEL` is optional and defaults to `gemini-2.5-flash`.

Run the dev server:

```bash
npm run dev
```

Open http://localhost:3000.

## API

`POST /api/summarize`

Request:

```json
{"url": "https://example.com"}
```

Success (200):

```json
{
  "title": "Example Domain",
  "url": "https://example.com/",
  "summary": "...",
  "requestId": "..."
}
```

Errors return `{ "error": "message", "requestId": "..." }` with these statuses:

| Status | Meaning                                                    |
| ------ | ---------------------------------------------------------- |
| 400    | Invalid JSON, missing or invalid URL, or a blocked address |
| 422    | The page was not HTML or had no readable text              |
| 500    | Server misconfiguration or unexpected error                |
| 502    | The target site or Gemini failed                           |
| 503    | Gemini is rate limiting, try again shortly                 |
| 504    | The target site or Gemini timed out                        |

Try it:

```bash
curl -X POST http://localhost:3000/api/summarize \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

## Project structure

```
app/
  api/summarize/route.ts   API route, validation and error mapping
  page.tsx                 Client UI
lib/
  scrape.ts                Safe fetching and text extraction
  summarize.ts             Gemini client, timeout and retry
```
