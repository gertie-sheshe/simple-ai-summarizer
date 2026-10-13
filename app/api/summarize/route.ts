import {NextResponse} from "next/server";
import {scrapePage} from "@/lib/scrape";
import {summarizePage} from "@/lib/summarize";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {error: "Request body must be valid JSON"},
      {status: 400},
    );
  }

  const url = (body as {url?: unknown} | null)?.url;

  if (typeof url !== "string" || !url.trim()) {
    return NextResponse.json({error: "A url is required"}, {status: 400});
  }

  try {
    const page = await scrapePage(url.trim());
    const summary = await summarizePage(page);
    return NextResponse.json({title: page.title, url: page.url, summary});
  } catch (err) {
    console.error("Summarize failed:", err);
    const message = err instanceof Error ? err.message : "Something went wrong";
    return NextResponse.json({error: message}, {status: 500});
  }
}
