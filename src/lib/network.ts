import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import robotsParser from "robots-parser";
import { publicUrl } from "./feed";

const USER_AGENT = "DefenseTechMonitor/0.1";
const MAX_BYTES = 3 * 1024 * 1024;

export interface HttpResult {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

export function validateRemoteUrl(input: string) {
  const url = new URL(publicUrl(input));
  if (url.port && !["80", "443"].includes(url.port))
    throw new Error("Seuls les ports HTTP et HTTPS standards sont autorisés.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    (ipaddr.isValid(host) && !isPublicAddress(host))
  ) {
    throw new Error("Les adresses locales ou privées ne sont pas autorisées.");
  }
  return url;
}

async function requestOnce(
  url: URL,
  headers: Record<string, string>,
): Promise<HttpResult> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const deadline = Date.now() + 15000;
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(host, { all: true }),
    new Promise<never>((_, reject) => {
      dnsTimer = setTimeout(
        () => reject(new Error("Délai de résolution DNS dépassé.")),
        15000,
      );
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
    throw new Error(
      "La source doit résoudre uniquement vers des adresses publiques.",
    );
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const options: RequestOptions & { autoSelectFamily: boolean } = {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept:
          "application/rss+xml, application/atom+xml, application/xml, text/html;q=0.8, */*;q=0.1",
        "accept-encoding": "identity",
        ...headers,
      },
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      // Pin the validated DNS answer; a second lookup must not reach a private address.
      lookup: ((
        _hostname: string,
        _options: unknown,
        callback: (error: null, address: string, family: number) => void,
      ) =>
        callback(
          null,
          pinned.address,
          pinned.family,
        )) as RequestOptions["lookup"],
      autoSelectFamily: false,
    };
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      options,
      (res) => {
        const chunks: Buffer[] = [];
        let length = 0;
        res.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_BYTES) {
            res.destroy(new Error("Réponse trop volumineuse (maximum 3 Mo)."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            url: url.toString(),
            status: res.statusCode ?? 500,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(", ") : (value ?? ""),
              ]),
            ),
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export async function safeFetch(
  input: string,
  headers: Record<string, string> = {},
  beforeRequest?: (url: string) => Promise<void>,
): Promise<HttpResult> {
  let url = validateRemoteUrl(input);
  for (let redirect = 0; redirect <= 4; redirect++) {
    if (beforeRequest) await beforeRequest(url.toString());
    const response = await requestOnce(url, headers);
    if (
      [301, 302, 303, 307, 308].includes(response.status) &&
      response.headers.location
    ) {
      url = validateRemoteUrl(
        new URL(response.headers.location, url).toString(),
      );
      headers = {};
      continue;
    }
    return response;
  }
  throw new Error("Trop de redirections.");
}

const robotsCache = new Map<
  string,
  { expiresAt: number; rules: ReturnType<typeof robotsParser> }
>();
const lastRequests = new Map<string, number>();

async function respectRobots(input: string) {
  const url = validateRemoteUrl(input);
  const robotsUrl = new URL("/robots.txt", url).toString();
  let cached = robotsCache.get(url.origin);
  if (!cached || cached.expiresAt < Date.now()) {
    const response = await safeFetch(robotsUrl);
    if (response.status !== 404 && response.status >= 400)
      throw new Error(
        `Impossible de vérifier robots.txt (HTTP ${response.status}).`,
      );
    cached = {
      expiresAt: Date.now() + 3600000,
      rules: robotsParser(
        robotsUrl,
        response.status === 404 ? "" : response.body,
      ),
    };
    robotsCache.set(url.origin, cached);
  }
  if (cached.rules.isAllowed(input, USER_AGENT) === false)
    throw new Error("La collecte de cette URL est interdite par robots.txt.");
  const delay = Math.max(0, cached.rules.getCrawlDelay(USER_AGENT) ?? 0) * 1000;
  if (Date.now() - (lastRequests.get(url.origin) ?? 0) < delay)
    throw new Error(
      "Délai demandé par la source : réessayer à la prochaine collecte.",
    );
  lastRequests.set(url.origin, Date.now());
}

export async function fetchResource(
  input: string,
  headers: Record<string, string> = {},
  acceptUrl?: (url: string) => boolean,
) {
  return safeFetch(input, headers, async (url) => {
    if (acceptUrl && !acceptUrl(url))
      throw new Error("La page a redirigé vers une autre publication.");
    await respectRobots(url);
  });
}
