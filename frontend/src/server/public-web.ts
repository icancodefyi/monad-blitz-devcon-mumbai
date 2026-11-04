import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

import ipaddr from "ipaddr.js";

const MAX_REDIRECTS = 3;
const MAX_TEXT_BYTES = 500_000;

export type PublicTarget = {
  url: URL;
  address: string;
  family: 4 | 6;
};

type PinnedResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

export function isPublicAddress(value: string): boolean {
  try {
    let parsed = ipaddr.parse(value);
    if (parsed.kind() === "ipv6") {
      const ipv6 = parsed as ipaddr.IPv6;
      if (ipv6.isIPv4MappedAddress()) parsed = ipv6.toIPv4Address();
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

export async function resolvePublicTarget(value: string): Promise<PublicTarget> {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Scout accepts public HTTP(S) URLs without embedded credentials.");
  }
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("Scout blocks non-standard web ports.");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new Error("Scout blocks private or reserved network sources.");
  }
  const selected = addresses[0];
  return { url, address: selected.address, family: selected.family as 4 | 6 };
}

function pinnedRequest(target: PublicTarget, maxBytes = MAX_TEXT_BYTES): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(target.url, {
      method: "GET",
      headers: { "user-agent": "DONADS-Scout/2.0", accept: "text/html,text/plain,application/json;q=0.9" },
      lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
      ...(target.url.protocol === "https:" ? { servername: target.url.hostname, rejectUnauthorized: true } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          request.destroy(new Error(`Source exceeds the ${maxBytes.toLocaleString("en-US")}-byte retrieval limit.`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.setTimeout(10_000, () => request.destroy(new Error("Source retrieval timed out after 10 seconds.")));
    request.on("error", reject);
    request.end();
  });
}

export async function fetchPublicText(source: string): Promise<{ url: string; title: string; body: string; target: PublicTarget }> {
  let target = await resolvePublicTarget(source);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await pinnedRequest(target);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location || redirect === MAX_REDIRECTS) throw new Error("Source redirected too many times.");
      target = await resolvePublicTarget(new URL(location, target.url).toString());
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Source returned HTTP ${response.status}.`);
    const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.includes("text/") && !contentType.includes("json")) throw new Error("Source is not readable text.");
    const raw = response.body.toString("utf8");
    const title = raw.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || target.url.hostname;
    const body = raw.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    return { url: target.url.toString(), title, body, target };
  }
  throw new Error("Source could not be fetched.");
}
