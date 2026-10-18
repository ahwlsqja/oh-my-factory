import { request } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readUiSnapshot } from "../../src/ui/read-model.js";
import { startUiServer, type UiServer } from "../../src/ui/server.js";
import { makeGitRepo, makeTempDir } from "../helpers/tmp.js";

const servers: UiServer[] = [];

async function fixture() {
  const cwd = makeGitRepo();
  const env = { HOME: makeTempDir("omf-ui-home-") };
  const readSnapshot = vi.fn(() => readUiSnapshot(cwd, env));
  const server = await startUiServer({ cwd, env, readSnapshot });
  servers.push(server);
  return { server, readSnapshot };
}

function get(
  server: UiServer,
  path = server.basePath,
  headers: Record<string, string | string[]> = {},
  method = "GET",
) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = request(server.origin, { path, method, headers, agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end();
    },
  );
}

function duplicateHost(server: UiServer): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(server.url);
    const socket = connect(Number(url.port), "127.0.0.1", () => {
      socket.end(
        `GET ${server.basePath}api/snapshot HTTP/1.1\r\nHost: ${url.host}\r\nHost: attacker.invalid\r\nConnection: close\r\n\r\n`,
      );
    });
    let response = "";
    socket.setEncoding("utf8").on("data", (chunk: string) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(response)?.[1])));
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("read-only UI HTTP boundary", () => {
  it("serves only capability-scoped HTML, local assets and the closed snapshot", async () => {
    const { server, readSnapshot } = await fixture();
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/$/);
    for (const path of ["", "index.html", "style.css", "app.js"]) {
      const res = await get(server, server.basePath + path);
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      const head = await get(server, server.basePath + path, {}, "HEAD");
      expect(head.status).toBe(200);
      expect(head.body).toBe("");
      expect(head.headers["content-length"]).toBe(res.headers["content-length"]);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["content-security-policy"]).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
      );
    }
    expect(readSnapshot).not.toHaveBeenCalled();
    const api = await get(server, `${server.basePath}api/snapshot`, { Origin: server.origin });
    expect(api.status).toBe(200);
    expect(api.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(api.body)).toEqual(readSnapshot.mock.results[0]?.value);
    const head = await get(server, `${server.basePath}api/snapshot`, {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.body).toBe("");
  });

  it("rejects Host, Origin and cross-site requests before reading any state", async () => {
    const { server, readSnapshot } = await fixture();
    for (const headers of [
      { Host: "attacker.invalid" },
      { Host: "localhost" },
      { Host: "127.0.0.1:1" },
      { Origin: "null" },
      { Origin: "https://attacker.invalid" },
      { Origin: `${server.origin}/` },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": ["cross-site", "same-origin"] },
      { Origin: [server.origin, "https://attacker.invalid"] },
    ]) {
      expect((await get(server, `${server.basePath}api/snapshot`, headers)).status).toBe(403);
    }
    expect(await duplicateHost(server)).toBe(403);
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it("rejects all mutation methods and raw unknown or traversal paths without state reads", async () => {
    const { server, readSnapshot } = await fixture();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) {
      const response = await get(server, `${server.basePath}api/snapshot`, {}, method);
      expect(response.status).toBe(405);
      expect(response.headers.allow).toBe("GET, HEAD");
    }
    for (const path of [
      "/",
      "/api/snapshot",
      "/wrong/index.html",
      "/wrong/style.css",
      "/wrong/app.js",
      "/wrong/api/snapshot",
      `${server.basePath}api/snapshot?project=other`,
      `${server.basePath}../api/snapshot`,
      `${server.basePath}%2e%2e/api/snapshot`,
      `${server.basePath}%zz`,
      `${server.basePath}api%2fsnapshot`,
      `${server.basePath}api//snapshot`,
      `${server.basePath}api/snapshot#fragment`,
      `http://attacker.invalid${server.basePath}api/snapshot`,
    ]) {
      expect((await get(server, path)).status, path).toBe(404);
      expect((await get(server, path, {}, "HEAD")).status, path).toBe(404);
    }
    expect(readSnapshot).not.toHaveBeenCalled();
  });

  it("returns only a generic API failure, including for HEAD", async () => {
    const cwd = makeGitRepo();
    const server = await startUiServer({
      cwd,
      readSnapshot: () => {
        throw new Error("private /home/person/state and secret-token");
      },
    });
    servers.push(server);
    const res = await get(server, `${server.basePath}api/snapshot`);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual({ error: "Unable to read project state." });
    expect(res.body).not.toMatch(/private|person|secret-token/);
    const head = await get(server, `${server.basePath}api/snapshot`, {}, "HEAD");
    expect(head.status).toBe(500);
    expect(head.body).toBe("");
  });

  it("uses independent random capabilities and closes idempotently", async () => {
    const first = await fixture();
    const second = await fixture();
    expect(first.server.basePath).not.toBe(second.server.basePath);
    await first.server.close();
    await first.server.close();
    await expect(get(first.server)).rejects.toThrow();
  });

  it("rejects a port already in use without disrupting the listening server", async () => {
    const { server } = await fixture();
    await expect(startUiServer({ cwd: makeGitRepo(), port: Number(new URL(server.url).port) })).rejects.toThrow();
    expect((await get(server)).status).toBe(200);
  });

  it("closes even when a client leaves an HTTP request unfinished", async () => {
    const { server } = await fixture();
    const socket = connect(Number(new URL(server.url).port), "127.0.0.1");
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write("GET / HTTP/1.1\r\n");
    await server.close();
    await closed;
  });

  it.each([-1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid port %s", async (port) => {
    await expect(startUiServer({ cwd: makeGitRepo(), port })).rejects.toThrow(
      "port must be an integer from 0 to 65535",
    );
  });
});
