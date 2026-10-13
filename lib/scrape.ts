import * as cheerio from "cheerio";
import {lookup} from "node:dns/promises";
import net from "node:net";

export type ScrapedPage = {
  url: string;
  title: string;
  description: string;
  text: string;
};

const MAX_CHARS = 30_000;
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 10_000;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe80")
  );
}

async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are allowed");
  }
  const addrs = await lookup(url.hostname, {all: true});
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error("That address is not allowed");
  }
  return url;
}

export async function scrapePage(rawUrl: string): Promise<ScrapedPage> {
  const url = await assertSafeUrl(rawUrl);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; SiteSummarizerBot/1.0)",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) throw new Error(`Fetch failed with status ${res.status}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new Error("URL did not return an HTML page");
  }

  const html = (await res.text()).slice(0, MAX_BYTES);
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim();
  const description =
    $('meta[name="description"]').attr("content")?.trim() ??
    $('meta[property="og:description"]').attr("content")?.trim() ??
    "";

  $(
    "script, style, noscript, svg, iframe, nav, footer, header, form, aside",
  ).remove();

  const root = $("main").length
    ? $("main")
    : $("article").length
      ? $("article")
      : $("body");
  const text = root.text().replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);

  if (!text)
    throw new Error(
      "No readable text found. The page may render with JavaScript.",
    );

  return {url: url.toString(), title, description, text};
}
