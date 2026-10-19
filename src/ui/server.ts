import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { UI_CSS, UI_HTML, UI_JS } from "./page.js";
import { readUiSnapshot } from "./read-model.js";
import type { UiSnapshot } from "./types.js";

export interface UiServer {
  url: string;
  origin: string;
  basePath: string;
  close(): Promise<void>;
}

export interface UiServerOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  port?: number;
  readSnapshot?: (cwd: string, env: NodeJS.ProcessEnv) => UiSnapshot | Promise<UiSnapshot>;
}

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";

function headerCount(req: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function respond(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: string,
  type = "text/plain; charset=utf-8",
): void {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(req.method === "HEAD" ? undefined : body);
}

/** A fixed-project, fixed-route reader. No HTTP route accepts a filesystem path or writes project state. */
export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("port must be an integer from 0 to 65535");
  }
  const env = options.env ?? process.env;
  const readSnapshot = options.readSnapshot ?? readUiSnapshot;
  const capability = randomBytes(24);
  const basePath = `/${capability.toString("hex")}/`;
  let origin = "";
  const server = createServer((req, res) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");

    if (
      headerCount(req, "host") !== 1 ||
      req.headers.host !== origin.slice("http://".length) ||
      headerCount(req, "origin") > 1 ||
      (req.headers.origin !== undefined && req.headers.origin !== origin) ||
      headerCount(req, "sec-fetch-site") > 1
    ) {
      respond(req, res, 403, "Forbidden\n");
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      respond(req, res, 405, "Method not allowed\n");
      return;
    }

    const requestedCapability = /^\/([a-f0-9]{48})\//.exec(req.url ?? "")?.[1];
    if (requestedCapability === undefined || !timingSafeEqual(Buffer.from(requestedCapability, "hex"), capability)) {
      respond(req, res, 404, "Not found\n");
      return;
    }

    // A local redirect file starts a cross-site navigation. Exempt only the authenticated top-level
    // page; this metadata does not prove file provenance, and never permits cross-site API or asset reads.
    const pageNavigation =
      req.method === "GET" &&
      (req.url === basePath || req.url === `${basePath}index.html`) &&
      req.headers["sec-fetch-site"] === "cross-site" &&
      headerCount(req, "sec-fetch-mode") === 1 &&
      req.headers["sec-fetch-mode"] === "navigate" &&
      headerCount(req, "sec-fetch-dest") === 1 &&
      req.headers["sec-fetch-dest"] === "document";
    if (
      req.headers["sec-fetch-site"] !== undefined &&
      !["none", "same-origin"].includes(String(req.headers["sec-fetch-site"])) &&
      !pageNavigation
    ) {
      respond(req, res, 403, "Forbidden\n");
      return;
    }

    // Match the original request target, never a normalized URL that could hide dots, encodings or queries.
    switch (req.url) {
      case basePath:
      case `${basePath}index.html`:
        respond(req, res, 200, UI_HTML, "text/html; charset=utf-8");
        return;
      case `${basePath}style.css`:
        respond(req, res, 200, UI_CSS, "text/css; charset=utf-8");
        return;
      case `${basePath}app.js`:
        respond(req, res, 200, UI_JS, "text/javascript; charset=utf-8");
        return;
      case `${basePath}api/snapshot`:
        void Promise.resolve()
          .then(() => readSnapshot(options.cwd, env))
          .then((snapshot) => {
            const body = JSON.stringify(snapshot);
            respond(req, res, 200, body, "application/json; charset=utf-8");
          })
          .catch(() => {
            respond(
              req,
              res,
              500,
              JSON.stringify({ error: "Unable to read project state." }),
              "application/json; charset=utf-8",
            );
          });
        return;
      default:
        respond(req, res, 404, "Not found\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== "127.0.0.1") {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    throw new Error("Unable to bind the UI server to IPv4 loopback.");
  }
  origin = `http://${address.address}:${address.port}`;
  let closing: Promise<void> | undefined;
  return {
    url: `${origin}${basePath}`,
    origin,
    basePath,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        // A client with an unfinished request must not hold Ctrl+C shutdown open.
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
