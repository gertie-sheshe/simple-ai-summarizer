import * as cheerio from "cheerio";
import dns from "node:dns";
import net from "node:net";
import {Agent, fetch, type Response} from "undici";

export type ScrapedPage = {
  url: string;
  title: string;
  description: string;
  text: string;
};

export type ScrapeErrorKind =
  | "invalid_url"
  | "blocked"
  | "upstream"
  | "timeout"
  | "unreadable";

export class ScrapeError extends Error {
  kind: ScrapeErrorKind;
  constructor(message: string, kind: ScrapeErrorKind, options?: ErrorOptions) {
    super(message, options);
    this.name = "ScrapeError";
    this.kind = kind;
  }
}

class BlockedAddressError extends Error {
  constructor() {
    super("Blocked address");
    this.name = "BlockedAddressError";
  }
}

const MAX_CHARS = 30_000;
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Address ranges we never connect to
const blocklist = new net.BlockList();
blocklist.addSubnet("0.0.0.0", 8, "ipv4"); // "this" network
blocklist.addSubnet("10.0.0.0", 8, "ipv4"); // private
blocklist.addSubnet("100.64.0.0", 10, "ipv4"); // carrier-grade NAT
blocklist.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
blocklist.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, cloud metadata
blocklist.addSubnet("172.16.0.0", 12, "ipv4"); // private
blocklist.addSubnet("192.0.0.0", 24, "ipv4"); // IETF reserved
blocklist.addSubnet("192.168.0.0", 16, "ipv4"); // private
blocklist.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
blocklist.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
blocklist.addSubnet("240.0.0.0", 4, "ipv4"); // reserved
blocklist.addAddress("::", "ipv6");
blocklist.addAddress("::1", "ipv6");
blocklist.addSubnet("fc00::", 7, "ipv6"); // unique local
blocklist.addSubnet("fe80::", 10, "ipv6"); // link-local
blocklist.addSubnet("ff00::", 8, "ipv6"); // multicast
blocklist.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64

function isBlockedIp(ip: string): boolean {
  if (!net.isIP(ip)) return true;
  return blocklist.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");
}

// Validates the exact addresses the socket will use, at connect time.
// This closes the DNS rebinding gap and covers every redirect hop.
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, {...options, all: true}, (err, addresses) => {
    if (err) return callback(err, "", 0);
    if (
      addresses.length === 0 ||
      addresses.some((a) => isBlockedIp(a.address))
    ) {
      return callback(new BlockedAddressError(), "", 0);
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
};

const dispatcher = new Agent({connect: {lookup: safeLookup}});

function parseHttpUrl(raw: string, base?: string): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new ScrapeError("Invalid URL", "invalid_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ScrapeError(
      "Only http and https URLs are allowed",
      "invalid_url",
    );
  }
  if (url.username || url.password) {
    throw new ScrapeError(
      "URLs with credentials are not allowed",
      "invalid_url",
    );
  }
  // IP literals skip DNS, so the lookup hook never sees them
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isBlockedIp(host)) {
    throw new ScrapeError("That address is not allowed", "blocked");
  }
  return url;
}

async function fetchFollowingRedirects(startUrl: URL, signal: AbortSignal) {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetch(current, {
      dispatcher,
      signal,
      redirect: "manual",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SiteSummarizerBot/1.0)",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get("location");
      await res.body?.cancel();
      if (!location)
        throw new ScrapeError("Redirect without a location", "upstream");
      current = parseHttpUrl(location, current.toString()); // re-validate every hop
      continue;
    }

    return {res, finalUrl: current};
  }

  throw new ScrapeError("Too many redirects", "upstream");
}

// Stops reading as soon as the cap is hit instead of buffering everything
async function readBodyCapped(
  res: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const {done, value} = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

function decodeHtml(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function toScrapeError(err: unknown): ScrapeError {
  if (err instanceof ScrapeError) return err;

  // fetch wraps the real failure in err.cause, so walk the chain
  let e: unknown = err;
  for (let i = 0; i < 5 && e; i++) {
    if (e instanceof BlockedAddressError) {
      return new ScrapeError("That address is not allowed", "blocked", {
        cause: err,
      });
    }
    const {name, code} = e as {name?: string; code?: string};
    if (name === "TimeoutError" || name === "AbortError") {
      return new ScrapeError("The site took too long to respond", "timeout", {
        cause: err,
      });
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      return new ScrapeError("Could not resolve that host", "upstream", {
        cause: err,
      });
    }
    e = (e as {cause?: unknown}).cause;
  }
  return new ScrapeError("Could not reach the site", "upstream", {cause: err});
}

function extractPage(html: string, finalUrl: URL): ScrapedPage {
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

  if (!text) {
    throw new ScrapeError(
      "No readable text found. The page may render with JavaScript.",
      "unreadable",
    );
  }

  return {url: finalUrl.toString(), title, description, text};
}

export async function scrapePage(rawUrl: string): Promise<ScrapedPage> {
  const startUrl = parseHttpUrl(rawUrl);
  const signal = AbortSignal.timeout(TIMEOUT_MS); // one deadline for the whole operation

  try {
    const {res, finalUrl} = await fetchFollowingRedirects(startUrl, signal);

    if (!res.ok) {
      await res.body?.cancel();
      throw new ScrapeError(
        `The site responded with status ${res.status}`,
        "upstream",
      );
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      await res.body?.cancel();
      throw new ScrapeError(
        "That URL did not return an HTML page",
        "unreadable",
      );
    }

    const bytes = await readBodyCapped(res, MAX_BYTES);
    return extractPage(decodeHtml(bytes, contentType), finalUrl);
  } catch (err) {
    throw toScrapeError(err);
  }
}
