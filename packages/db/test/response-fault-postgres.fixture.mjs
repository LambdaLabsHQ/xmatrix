import assert from "node:assert/strict";
import { Client } from "pg";
import { createAuthorityDatabase } from "../dist/index.js";
import { connectionString } from "./postgres-database.fixture.mjs";

/** Lose a real SQL response after PostgreSQL executed it, preserving transaction ownership. */
export function recoveringDatabase(getFault) {
  const clients = [];
  let pendingClose = Promise.resolve();
  const database = createAuthorityDatabase({ connectionString, shardId: "shard-0",
    clientFactory(config) {
      const client = new Client(config);
      const entry = { queries: [], ended: false };
      clients.push(entry);
      const connect = client.connect.bind(client);
      client.connect = async () => { await pendingClose; return connect(); };
      const query = client.query.bind(client);
      client.query = async input => {
        assert.equal(entry.ended, false, "a destroyed checkout cannot be reused");
        const text = typeof input === "string" ? input : input.text;
        entry.queries.push(text);
        const result = await query(input);
        const fault = getFault();
        if (fault?.matches.test(text) && fault.remaining > 0) {
          fault.remaining -= 1;
          fault.checkouts.push(entry);
          entry.fault = fault;
          await fault.beforeThrow?.();
          throw fault.errors?.shift() ?? fault.error;
        }
        return result;
      };
      const end = client.end.bind(client);
      client.end = () => {
        entry.ended = true;
        pendingClose = end().then(async () => {
          const afterClose = entry.fault?.afterClose;
          if (afterClose) { delete entry.fault.afterClose; await afterClose(); }
        });
        return pendingClose;
      };
      return client;
    },
  });
  return { database, clients };
}

