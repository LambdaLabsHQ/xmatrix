/**
 * A short bounded queue absorbs transient Hyperdrive checkout contention while
 * staying below the client-side message cancellation budget. Hyperdrive owns
 * cross-request pooling; this is not an application connection pool.
 */
export const POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS = 8_000;
