import { createHash } from "node:crypto";
import type { FeedEntry } from "./feed";

export type XFetch = typeof fetch;

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const ID = /^[1-9][0-9]{0,18}$/;
const USERNAME = /^[a-z0-9_]{1,15}$/i;
const PAGE_TOKEN = /^[a-z0-9_-]{1,2048}={0,2}$/i;
const RESERVED_PATHS = new Set([
  "about",
  "account",
  "accounts",
  "business",
  "communities",
  "compose",
  "download",
  "explore",
  "grok",
  "hashtag",
  "help",
  "home",
  "i",
  "intent",
  "jobs",
  "login",
  "logout",
  "messages",
  "notifications",
  "oauth",
  "premium",
  "privacy",
  "search",
  "settings",
  "share",
  "signup",
  "tos",
  "welcome",
  "widgets",
]);

export function parseXAccount(
  input: string,
): { username: string; url: string } | null {
  const value = input.trim();
  let username: string;
  if (/^@?[a-z0-9_]{1,15}$/i.test(value)) {
    username = value.replace(/^@/, "");
  } else {
    // Validate the raw URL before URL normalization can remove ports or dot segments.
    const match = value.match(
      /^https:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/([a-z0-9_]{1,15})\/?(?:[?#][^\s\\]*)?$/i,
    );
    if (!match) return null;
    username = match[1];
  }
  username = username.toLowerCase();
  if (RESERVED_PATHS.has(username)) return null;
  return { username, url: `https://x.com/${username}` };
}

export class XApiError extends Error {
  readonly status: number | null;
  /** Suggested delay in seconds, when X provides one. */
  readonly retryAfter: number | null;
  readonly beforeRequest: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      retryAfter?: number | null;
      beforeRequest?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "XApiError";
    this.status = options.status ?? null;
    this.retryAfter = options.retryAfter ?? null;
    this.beforeRequest = options.beforeRequest ?? false;
  }
}

function invalidResponse(): never {
  throw new XApiError("La réponse de X est incomplète ou invalide.");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidResponse();
  return value as Record<string, unknown>;
}

function validateId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) invalidResponse();
  return value;
}

function validateUsername(value: unknown): string {
  if (typeof value !== "string" || !USERNAME.test(value)) invalidResponse();
  return value.toLowerCase();
}

function validateToken(value: unknown): string {
  if (typeof value !== "string" || !PAGE_TOKEN.test(value)) invalidResponse();
  return value;
}

function retryDelay(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (value) {
    if (/^\d+$/.test(value)) {
      const seconds = Number(value);
      if (Number.isSafeInteger(seconds)) return seconds;
    }
    const date = Date.parse(value);
    if (Number.isFinite(date))
      return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  const reset = response.headers.get("x-rate-limit-reset");
  if (response.status === 429 && reset && /^\d+$/.test(reset)) {
    const seconds = Number(reset);
    if (Number.isSafeInteger(seconds))
      return Math.max(0, Math.ceil(seconds - Date.now() / 1000));
  }
  return null;
}

async function request(
  url: URL,
  apiKey: string,
  fetcher: XFetch,
): Promise<Record<string, unknown>> {
  if (!apiKey || apiKey.length > 4096 || !/^[\x21-\x7e]+$/.test(apiKey))
    throw new XApiError("Le jeton X est absent ou invalide.", {
      beforeRequest: true,
    });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      redirect: "error",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new XApiError(
        response.status === 429
          ? "La limite de requêtes X est atteinte. Réessaie plus tard."
          : response.status === 401 || response.status === 403
            ? "X refuse l’accès. Vérifie le jeton et les droits de l’application."
            : response.status === 402
              ? "Le crédit API X est insuffisant."
              : response.status === 404
                ? "Ce compte X est introuvable ou inaccessible."
                : "La requête vers X a échoué.",
        { status: response.status, retryAfter: retryDelay(response) },
      );
    }
    if (
      response.redirected ||
      (response.url && new URL(response.url).origin !== "https://api.x.com")
    )
      invalidResponse();
    const declaredLength = Number(
      response.headers.get("content-length") ?? "0",
    );
    if (declaredLength > MAX_RESPONSE_BYTES || !response.body) {
      await response.body?.cancel();
      invalidResponse();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          invalidResponse();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const payload = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    if (
      payload.errors !== undefined &&
      (!Array.isArray(payload.errors) || payload.errors.length)
    )
      invalidResponse();
    return payload;
  } catch (error) {
    if (error instanceof XApiError) throw error;
    // Provider bodies, fetch errors and JSON errors can contain credentials or URLs.
    throw new XApiError(
      controller.signal.aborted
        ? "X n’a pas répondu à temps."
        : "Impossible de récupérer une réponse valide de X.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function lookupXUser(
  username: string,
  apiKey: string,
  fetcher: XFetch = fetch,
): Promise<{ id: string; username: string }> {
  if (!USERNAME.test(username) || RESERVED_PATHS.has(username.toLowerCase()))
    throw new XApiError("Le nom du compte X est invalide.", {
      beforeRequest: true,
    });
  const payload = await request(
    new URL(`https://api.x.com/2/users/by/username/${username.toLowerCase()}`),
    apiKey,
    fetcher,
  );
  const user = object(payload.data);
  const returnedUsername = validateUsername(user.username);
  if (returnedUsername !== username.toLowerCase()) invalidResponse();
  return { id: validateId(user.id), username: returnedUsername };
}

function clip(text: string, limit: number): string {
  return text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
}

function preview(text: string, limit: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  const part = clip(compact, limit - 1);
  const boundary = part.lastIndexOf(" ");
  return `${boundary >= limit * 0.7 ? part.slice(0, boundary) : part}…`;
}

function parsePost(value: unknown, username: string): FeedEntry {
  const post = object(value);
  const id = validateId(post.id);
  if (typeof post.text !== "string" || !post.text.trim()) invalidResponse();
  // Current API documentation uses note_post; older API responses use note_tweet.
  let body = post.text;
  for (const field of ["note_tweet", "note_post"]) {
    if (post[field] === undefined) continue;
    const note = object(post[field]);
    if (typeof note.text !== "string" || !note.text.trim()) invalidResponse();
    body = note.text;
  }
  const text = body.trim();
  if (text.length > 100_000) invalidResponse();
  const title = preview(text, 160);
  const excerpt = preview(text, 480);
  if (
    typeof post.created_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
      post.created_at,
    ) ||
    !Number.isFinite(Date.parse(post.created_at))
  )
    invalidResponse();
  const publishedAt = new Date(post.created_at).toISOString();
  if (publishedAt !== post.created_at.replace(/(?<!\.\d{3})Z$/, ".000Z"))
    invalidResponse();
  let language = "und";
  if (post.lang !== undefined) {
    if (
      typeof post.lang !== "string" ||
      !/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(post.lang)
    )
      invalidResponse();
    language = post.lang.toLowerCase().split("-")[0];
  }
  const url = `https://x.com/${username}/status/${id}`;
  const format = "post";
  return {
    guid: id,
    url,
    title,
    publishedAt,
    text,
    excerpt,
    language,
    format,
    contentBasis: "feed_text",
    contentHash: createHash("sha256")
      .update(
        JSON.stringify([
          url,
          title,
          publishedAt,
          text,
          excerpt,
          language,
          format,
        ]),
      )
      .digest("hex"),
  };
}

export async function fetchXPosts(
  options: {
    userId: string;
    username: string;
    apiKey: string;
    maxResults: number;
    sinceId?: string;
    paginationToken?: string;
  },
  fetcher: XFetch = fetch,
): Promise<{
  entries: FeedEntry[];
  resourceCount: number;
  newestId: string | null;
  nextToken: string | null;
}> {
  const { userId, username, apiKey, maxResults, sinceId, paginationToken } =
    options;
  if (
    !ID.test(userId) ||
    !USERNAME.test(username) ||
    !Number.isInteger(maxResults) ||
    maxResults < 5 ||
    maxResults > 100 ||
    (sinceId !== undefined && !ID.test(sinceId)) ||
    (paginationToken !== undefined && !PAGE_TOKEN.test(paginationToken))
  )
    throw new XApiError("Les paramètres de collecte X sont invalides.", {
      beforeRequest: true,
    });
  const url = new URL(`https://api.x.com/2/users/${userId}/tweets`);
  url.searchParams.set("max_results", String(maxResults));
  url.searchParams.set("exclude", "replies,retweets");
  url.searchParams.set("post.fields", "created_at,lang,note_post");
  if (sinceId) url.searchParams.set("since_id", sinceId);
  if (paginationToken)
    url.searchParams.set("pagination_token", paginationToken);
  const payload = await request(url, apiKey, fetcher);
  const meta = object(payload.meta);
  if (
    !Number.isInteger(meta.result_count) ||
    Number(meta.result_count) < 0 ||
    Number(meta.result_count) > maxResults
  )
    invalidResponse();
  const data =
    payload.data === undefined && meta.result_count === 0 ? [] : payload.data;
  if (!Array.isArray(data) || data.length !== meta.result_count)
    invalidResponse();
  const entries = data.map((post) => parsePost(post, username.toLowerCase()));
  const ids = entries.map((entry) => entry.guid);
  if (
    new Set(ids).size !== ids.length ||
    (sinceId && ids.some((id) => BigInt(id) <= BigInt(sinceId)))
  )
    invalidResponse();
  const newestId = ids.reduce<string | null>(
    (newest, id) => (!newest || BigInt(id) > BigInt(newest) ? id : newest),
    null,
  );
  if (meta.newest_id !== undefined && validateId(meta.newest_id) !== newestId)
    invalidResponse();
  const nextToken =
    meta.next_token === undefined ? null : validateToken(meta.next_token);
  if (nextToken && (entries.length === 0 || nextToken === paginationToken))
    invalidResponse();
  return { entries, resourceCount: entries.length, newestId, nextToken };
}
