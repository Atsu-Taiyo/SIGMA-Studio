import type { PersonalDataPort } from "../authoring-style-sync";
import { CollaborationHttpError, readResponseJson } from "./transport";

/**
 * The signed-in account's own small documents on the collaboration server
 * (`/profile/data/<key>`). Only the account itself can read them. The server
 * decides whose they are from the token, never from the request.
 *
 * Runs in the main process only, like every other call to the server.
 */

type Fetcher = (route: string, init?: RequestInit) => Promise<Response>;

const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_RESPONSE_BYTES = 512 * 1024;

export class PersonalDataClient implements PersonalDataPort {
  constructor(private readonly fetcher: Fetcher) {}

  async read(key: string): Promise<{ revision: string | null; content: unknown }> {
    const value = await readResponseJson<unknown>(await this.fetcher(route(key)), MAX_RESPONSE_BYTES);
    const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
    if (body.revision === null) return { revision: null, content: null };
    if (typeof body.revision !== "string" || !body.revision || body.revision.length > 200) throw new Error("INVALID_PERSONAL_DATA");
    return { revision: body.revision, content: body.content };
  }

  async write(key: string, content: unknown, expectedRevision: string | null): Promise<{ revision: string } | "conflict"> {
    let response: Response;
    try {
      response = await this.fetcher(route(key), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision, content }) });
    } catch (error) {
      // Another device wrote first. The caller reads that copy and merges again.
      if (error instanceof CollaborationHttpError && error.status === 409) return "conflict";
      throw error;
    }
    const value = await readResponseJson<unknown>(response, 4096);
    const revision = value && typeof value === "object" ? (value as Record<string, unknown>).revision : null;
    if (typeof revision !== "string" || !revision || revision.length > 200) throw new Error("INVALID_PERSONAL_DATA");
    return { revision };
  }

  async removeAll(): Promise<void> {
    await this.fetcher("/profile/data", { method: "DELETE" });
  }
}

function route(key: string): string {
  if (!KEY.test(key)) throw new Error("INVALID_PERSONAL_DATA_KEY");
  return `/profile/data/${key}`;
}
