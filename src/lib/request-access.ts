import { timingSafeEqual } from "node:crypto";

export type RequestAccessEnvironment = {
  DTM_APP_ORIGIN?: string;
  DTM_PROXY_SECRET?: string;
};

export type RequestAccessContext = {
  mode: "local" | "hosted";
  origin: string;
};

export class RequestAccessError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 503,
  ) {
    super(message);
    this.name = "RequestAccessError";
  }
}

function invalidConfiguration(): never {
  throw new RequestAccessError(
    "L’accès à l’application n’est pas correctement configuré.",
    503,
  );
}

function denied(): never {
  throw new RequestAccessError(
    "Cette requête ne provient pas d’un accès autorisé à l’application.",
    403,
  );
}

/** Check the connection boundary before reading a body or opening personal data. */
export function assertRequestAccess(
  request: Request,
  environment: RequestAccessEnvironment = {
    DTM_APP_ORIGIN: process.env.DTM_APP_ORIGIN,
    DTM_PROXY_SECRET: process.env.DTM_PROXY_SECRET,
  },
): RequestAccessContext {
  const configuredOrigin = environment.DTM_APP_ORIGIN;
  const secret = environment.DTM_PROXY_SECRET;
  const host = request.headers.get("host");

  if (configuredOrigin !== undefined || secret !== undefined) {
    if (
      typeof configuredOrigin !== "string" ||
      typeof secret !== "string" ||
      !/^[0-9a-fA-F]{64}$/.test(secret)
    )
      invalidConfiguration();
    let origin: URL;
    try {
      origin = new URL(configuredOrigin);
    } catch {
      invalidConfiguration();
    }
    if (
      origin.protocol !== "https:" ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== "" ||
      origin.origin !== configuredOrigin
    )
      invalidConfiguration();
    if (host !== origin.host) denied();
    const supplied = request.headers.get("x-dtm-proxy-secret");
    if (supplied === null) denied();
    const actualBytes = Buffer.from(supplied, "utf8");
    const expectedBytes = Buffer.from(secret, "utf8");
    if (
      actualBytes.byteLength !== expectedBytes.byteLength ||
      !timingSafeEqual(actualBytes, expectedBytes)
    )
      denied();
    return { mode: "hosted", origin: configuredOrigin };
  }

  if (!host) denied();
  let target: URL;
  try {
    const protocol = new URL(request.url).protocol;
    if (protocol !== "http:" && protocol !== "https:") denied();
    target = new URL(`${protocol}//${host}`);
  } catch {
    denied();
  }
  if (
    target.host !== host ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
  )
    denied();
  return { mode: "local", origin: target.origin };
}

/** Require an exact browser origin for mutations, including HTTPS when hosted. */
export function assertRequestOrigin(
  request: Request,
  access: RequestAccessContext,
  mutation = false,
): void {
  const origin = request.headers.get("origin");
  if (
    (mutation && origin !== access.origin) ||
    (origin !== null && origin !== access.origin) ||
    request.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site"
  )
    throw new RequestAccessError("Origine de requête non autorisée.", 403);
}
