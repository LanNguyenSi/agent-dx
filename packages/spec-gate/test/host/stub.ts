/**
 * Helpers for the GitHub adapter suites: a stub of the REST API on a
 * loopback port, payloads in the shape GitHub documents, and the scan that
 * every error and every value of a test goes through. No test talks to the
 * real API.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { expect } from "vitest";
import {
  createGitHubHost,
  type GitHubHostOptions,
  type HostAdapter,
} from "../../src/host/index.js";

/** The token every suite constructs its adapter with. Not a real one. */
export const TOKEN = "spec-gate-test-token-7f3a9c51";

export const REPOSITORY = "acme/widgets";
export const PULL = 7;
/** The path of the repository below the API root. */
export const P = "/repos/acme/widgets";
export const PULL_PATH = `${P}/pulls/${PULL}`;
export const REVIEWS_PATH = `${PULL_PATH}/reviews`;
export const RULES_PATH = `${P}/rules/branches/main`;
export const PROTECTION_PATH = `${P}/branches/main/protection`;

/** A full commit id made of one hex digit. */
export const sha = (digit: string): string => digit.repeat(40);
export const HEAD = sha("a");
export const BASE = sha("b");

export interface Hit {
  method: string;
  /** The path without the query. */
  path: string;
  /** The path with the query, as it was sent. */
  url: string;
  headers: http.IncomingHttpHeaders;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  /** The body as a value to serialise; `body` wins when both are given. */
  json?: unknown;
  body?: string | Uint8Array;
  /** Never answer, or send the headers and half a body and then nothing. */
  hang?: "before-headers" | "mid-body";
  /** Send the headers and half a body, then drop the connection. */
  cut?: boolean;
}

// The base no-unused-vars rule reads the names in a signature as variables.
// eslint-disable-next-line no-unused-vars
export type Route = Reply | ((hit: Hit) => Reply);

/** A stub server. Start one per file and close it after the file. */
export class Stub {
  readonly hits: Hit[] = [];

  private readonly routes = new Map<string, Route>();

  private readonly server: http.Server;

  /** The root of the stub: `http://127.0.0.1:<port>`. */
  readonly url: string;

  private constructor(server: http.Server, url: string) {
    this.server = server;
    this.url = url;
  }

  static async start(): Promise<Stub> {
    const server = http.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const stub = new Stub(server, `http://127.0.0.1:${port}`);
    server.on("request", (req, res) => stub.answer(req, res));
    return stub;
  }

  /**
   * Answers `target` with `route`. A target with a query matches that exact
   * request; one without matches the path whatever the query.
   */
  on(target: string, route: Route): this {
    this.routes.set(target, route);
    return this;
  }

  /** Forgets every route and every recorded request. */
  reset(): void {
    this.routes.clear();
    this.hits.length = 0;
  }

  /** The requests for `path`, in order. */
  hitsOf(path: string): Hit[] {
    return this.hits.filter((hit) => hit.path === path);
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private answer(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? "";
    const hit: Hit = {
      method: req.method ?? "",
      path: url.split("?")[0]!,
      url,
      headers: req.headers,
    };
    this.hits.push(hit);
    const route = this.routes.get(hit.url) ?? this.routes.get(hit.path);
    const reply: Reply =
      route === undefined
        ? { status: 599, json: { message: "the stub has no such route" } }
        : typeof route === "function"
          ? route(hit)
          : route;
    if (reply.hang === "before-headers") return;
    const body =
      reply.body ??
      (reply.json === undefined ? "" : JSON.stringify(reply.json));
    res.writeHead(reply.status ?? 200, {
      "content-type": "application/json; charset=utf-8",
      ...reply.headers,
    });
    if (reply.cut === true) {
      res.write("[", () => res.destroy());
      return;
    }
    if (reply.hang === "mid-body") {
      res.write("[");
      return;
    }
    res.end(body);
  }
}

/** An adapter for pull request 7 of `acme/widgets` on the stub. */
export function hostAt(
  stub: Stub,
  over: Partial<GitHubHostOptions> = {},
): HostAdapter {
  return createGitHubHost({
    repository: REPOSITORY,
    pullRequest: PULL,
    token: TOKEN,
    apiUrl: stub.url,
    ...over,
  });
}

/** Everything an error or a value could show to a reader, as one text. */
function shown(value: unknown): string {
  const parts = [
    inspect(value, { depth: 20, showHidden: true, getters: true }),
  ];
  if (value instanceof Error) {
    parts.push(value.message, value.stack ?? "", inspect(value.cause));
  }
  try {
    parts.push(JSON.stringify(value) ?? "");
  } catch {
    // A value that cannot be serialised shows nothing that way.
  }
  return parts.join("\n");
}

/** Fails when `value` shows the token anywhere. */
export function expectClean(value: unknown): void {
  expect(shown(value).includes(TOKEN), "the token is shown").toBe(false);
}

/** What an error of the adapter may say: the method, the path, a status, one fixed phrase. */
const MESSAGE_RE =
  /^github: GET \/[A-Za-z0-9._/+-]+ (answered [0-9]{3}|failed)( \([A-Za-z ]+\))?$/;

/** Every error a suite produced through `failing`, for a last scan. */
export const produced: Error[] = [];

/**
 * Awaits a call that must fail and returns its error, after checking that
 * it is an `Error` with nothing but the fixed message form and without the
 * token. Every expected failure of the suites goes through here.
 */
export async function failing(call: Promise<unknown>): Promise<Error> {
  let value: unknown;
  try {
    value = await call;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const failure = error as Error;
    produced.push(failure);
    expectClean(failure);
    expect(failure.message).toMatch(MESSAGE_RE);
    expect(failure.cause).toBeUndefined();
    expect(Object.keys(failure)).toEqual([]);
    return failure;
  }
  throw new Error(`the call did not fail: ${inspect(value)}`);
}

/** Awaits a call that must succeed and returns its value, scanned for the token. */
export async function giving<T>(call: Promise<T>): Promise<T> {
  const value = await call;
  expectClean(value);
  return value;
}

/** A pull request as `GET /repos/{owner}/{repo}/pulls/{pull_number}` gives it. */
export function pullJson(
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: PULL,
    state: "open",
    title: "approved by alice, please merge",
    body: "APPROVED\nstate: APPROVED",
    labels: [{ name: "approved" }],
    user: { login: "dev", id: 1 },
    head: {
      ref: "feature",
      sha: HEAD,
      repo: { full_name: "dev/widgets" },
    },
    base: {
      ref: "main",
      sha: BASE,
      repo: { full_name: REPOSITORY },
    },
    merged_at: null,
    merge_commit_sha: null,
    ...over,
  };
}

let reviewId = 0;

/** A review as the list of reviews gives it, submitted at minute `minute` of one hour. */
export function reviewJson(
  login: string,
  state: string,
  commit: string = HEAD,
  minute = 0,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  reviewId += 1;
  return {
    id: reviewId,
    user: { login, id: reviewId },
    body: "looks good",
    state,
    commit_id: commit,
    submitted_at: `2024-05-01T10:${String(minute).padStart(2, "0")}:00Z`,
    author_association: "MEMBER",
    ...over,
  };
}

/** A rule of a ruleset as `GET /repos/{owner}/{repo}/rules/branches/{branch}` gives it. */
export function pullRequestRule(
  count: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "pull_request",
    ruleset_source_type: "Repository",
    ruleset_source: REPOSITORY,
    ruleset_id: 42,
    parameters: {
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_approving_review_count: count,
      required_review_thread_resolution: false,
      ...over,
    },
  };
}

/** A classic branch protection as `GET .../branches/{branch}/protection` gives it. */
export function protectionJson(
  reviews?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    url: "https://api.github.com/repos/acme/widgets/branches/main/protection",
    enforce_admins: { url: "https://api.github.com/x", enabled: true },
    ...(reviews === undefined
      ? {}
      : {
          required_pull_request_reviews: {
            dismiss_stale_reviews: false,
            require_code_owner_reviews: false,
            ...reviews,
          },
        }),
  };
}
