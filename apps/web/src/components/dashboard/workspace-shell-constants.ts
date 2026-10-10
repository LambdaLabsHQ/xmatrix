
import type { ComponentType } from "react";
import {
  Bell,
  Bot,
  Cpu,
  Database,
  Hash,
  MessageSquare,
  Radio,
  Shield,
  Zap,
} from "lucide-react";
import type { ChannelMessage } from "@xmatrix/protocol";
import { RELAY_V2_MESSAGE_ATTACHMENT_UPLOAD_MAX_BYTES } from "@xmatrix/protocol/relay-v2/message-attachment";

export const HISTORY_REFRESH_INTERVAL_MS = 30000;
/** When to re-read a channel's presence after one of its Instances went offline. */
export const RESTING_PRESENCE_REFRESH_DELAYS_MS = [4_000, 20_000] as const;

export const EMPTY_CHANNEL_HISTORY: ChannelMessage[] = [];

export const AGENT_REFRESH_INTERVAL_MS = 60000;

/**
 * The Hub answers this exact frame itself (a WebSocket auto-response), without
 * waking the Durable Object that holds the socket, so a short interval costs
 * nothing and a socket the OS dropped is replaced within seconds.
 */
export { HUMAN_HEARTBEAT_PING } from "@xmatrix/protocol";
export const RELAY_PUSH_PING_INTERVAL_MS = 25_000;
export const RELAY_PUSH_PONG_TIMEOUT_MS = 10_000;

export const HUMAN_FOCUS_STABILITY_MS = 50;

// The live socket is the primary first-page source: the focus request
// (debounced by HUMAN_FOCUS_STABILITY_MS) makes the Hub push the same page an
// HTTP bridge fetch would pull, so the bridge waits for that push before
// issuing a duplicate request. An empty window keeps a short grace so the
// skeleton never depends on a stalled socket; a painted window can wait the
// full push round-trip invisibly.
export const HUMAN_SOCKET_HISTORY_GRACE_MS = 250;
/** How long a mouse rests on a Channel row before its history is read ahead. */
export const CHANNEL_ROW_INTENT_DWELL_MS = 80;
export const HUMAN_SOCKET_HISTORY_PAINTED_GRACE_MS = 900;
export const PRODUCT_TAIL_CACHE_PERSIST_DEBOUNCE_MS = 800;

// Authority's product history contract caps a page at 50. Asking for 100 only
// inflated client expectations and follow-up work; it never returned more.
// Keep the first authority read small enough to render inside one 100 ms
// interaction budget. Older messages remain available through pagination.
export const INITIAL_HISTORY_LIMIT = 10;

export const OLDER_HISTORY_LIMIT = 50;

// How long opening a channel keeps owning the scroll position. A cold open
// paints in stages (tail cache, then the authority window, then late row
// growth from media and fonts), and every stage that ends at the tail renews
// this window, so the intent lives as long as the channel is still settling
// rather than for a fixed number of animation frames.
export const TIMELINE_BOTTOM_STICK_MS = 1200;

// Keep a measured buffer beyond both viewport edges. Message rows have
// dynamic heights (Markdown, media, code blocks), so pixels alone cannot
// protect a fast scroll across a few tall rows; Virtuoso also keeps this many
// rows mounted in each direction.
export const TIMELINE_VIRTUAL_VIEWPORT_PRELOAD_PX = 640;
export const TIMELINE_VIRTUAL_MIN_OVERSCAN_ITEMS = 2;

// A conversation opens on its latest rows before the virtual list takes over,
// and they render before its first frame. It takes at least a history page of
// them, and enough to fill the screen if every one were as short as a row gets;
// a conversation opened before takes what filled its screen then.
export const TIMELINE_OPENING_TAIL_ROWS = 12;
export const TIMELINE_OPENING_ROW_MIN_PX = 44;

// How many frames a message jump may spend placing its row before the intent
// is released. A jump issued on the commit that merged a history page is
// issued before the virtualizer has ingested that page, and its prepend
// anchoring runs afterwards, so the first call is undone: the landing has to
// be re-issued until the row is observably on screen. Bounded so a row that
// can never be placed releases the jump instead of spinning forever.
export const MESSAGE_JUMP_SETTLE_FRAMES = 12;

export const EVENT_LIMIT = 200;

export const XMATRIX_SYSTEM_AVATAR_URL = "/brand/xmatrix-management-icon.png";

export const TRACE_EVENT_LIMIT = 500;

/**
 * The single definition of channel tree indentation.
 *
 * Every row, and anything that has to line up with one, derives its offset
 * from here. A second copy of `8 + depth * 14` is how a control ends up
 * visually detached from the rows it belongs to when the tree's indentation
 * is later tuned.
 */
export const CHANNEL_ROW_INDENT_BASE_PX = 8;
export const CHANNEL_ROW_INDENT_STEP_PX = 14;

export function channelRowIndentPx(depth: number): number {
  return CHANNEL_ROW_INDENT_BASE_PX + depth * CHANNEL_ROW_INDENT_STEP_PX;
}

export const MAX_ATTACHMENTS = 10;

export const MAX_IMAGE_ATTACHMENT_BYTES = 1_000_000;

export const MAX_ATTACHMENT_BYTES = RELAY_V2_MESSAGE_ATTACHMENT_UPLOAD_MAX_BYTES;

export const MAX_COMPRESSED_IMAGE_DIMENSION = 1600;

export const CHANNEL_READ_COUNTS_STORAGE_PREFIX = "xmatrix:channel-read-counts:";

export const CHANNEL_MENTION_CLEARED_STORAGE_PREFIX = "xmatrix:channel-mention-cleared:";

/* Working workspace: the last space the user was actually in. Persisted in
   the cloud (shared-memory KV) so it follows the user across devices, with a
   localStorage mirror for instant first paint before the cloud read lands. */
export const WORKING_SPACE_STORAGE_PREFIX = "xmatrix:working-space:";

export const WORKING_SPACE_KV_KEY = "app:working-space.v1";

export const CHANNEL_HISTORY_CACHE_MAX_CHANNELS = 80;

export const CHANNEL_HISTORY_CACHE_MAX_MESSAGES = 120;

export const CHANNEL_HISTORY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export const AGENT_BUSY_TRACE_STALE_MS = 5 * 60 * 1000;

export const DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY = "xmatrix:desktop-sidebar-width";

/**
 * A desktop row is not just a name: it carries agent presence chips, an unread
 * count and a create action, so the name gets whatever is left. Measured on
 * `product-design` (14 chars, an ordinary name), the label stops clipping at
 * 352 and still clips at 288 — this is the compromise, wide enough that a
 * normal name survives the common case without eating a third of a 1280 laptop.
 */
export const DESKTOP_SIDEBAR_DEFAULT_WIDTH_PX = 320;

export const DESKTOP_SIDEBAR_MIN_WIDTH_PX = 224;

export const DESKTOP_SIDEBAR_MAX_WIDTH_PX = 420;

export const COLLAPSIBLE_MESSAGE_LENGTH = 3000;

export const COLLAPSIBLE_MESSAGE_LINES = 54;

export const COLLAPSED_MESSAGE_PREVIEW_LENGTH = 6000;

export const COLLAPSED_MESSAGE_PREVIEW_LINES = 80;

export const PLAIN_TEXT_MESSAGE_LENGTH = 50000;

export const AGENT_SPAWN_HANDOFF_GRACE_MS = 60000;

export const AGENT_SPAWN_PENDING_MAX_AGE_MS = 2 * 60 * 1000;

export const RELAY_CLIENT_PROFILE_STORAGE_KEY = "xmatrix:relay-v2:client-profile-id";

export const DESKTOP_SETUP_VERSION = 1;

export const AUTOMATION_REFRESH_INTERVAL_MS = 15_000;

export const IMAGE_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);


export const MARKDOWN_ATTACHMENT_TYPES = new Set(["text/markdown", "text/x-markdown"]);

export const MARKDOWN_ATTACHMENT_EXTENSIONS = [".md", ".markdown", ".mdown", ".mkd"];

export const QUICK_REACTION_EMOJIS = ["👍", "❤️", "😂", "🎉", "👀", "✅"];

/* The one chip material: `LiquidGlassPill`, the primitive the composer's
   buttons and the selected channel row render through. Count badges, the
   avatar stack's "+N" overflow, status labels and message metadata tags all
   wear this; `Tag` renders through the primitive itself, so it also gets the
   lens.

   These are the pill's own classes, so a chip is the same CSS rule as the
   composer's buttons rather than a recipe tuned to look like it — see
   liquid-glass.css. Without `app-material-liquid-pill` the mobile shell
   frosts a glass surface at 24px instead.

   Two earlier attempts were rejected, so do not reinvent them: bespoke
   per-theme `--m-count-*` gradients and `bg-sidebar-accent ring-1
   ring-sidebar`. A rim is fine; an inset white gloss is what wood must not
   carry.

   It lives here rather than in a component module because the shell chrome,
   the fleet views and the message timeline all need it, and chrome already
   imports from fleet views — putting it in either would close an import
   cycle. */
export const COUNT_CHIP_MATERIAL_CLASS =
  "app-shared-chip rounded-full app-material-liquid-pill app-liquid-glass-surface app-liquid-glass-fill";

export const EVENT_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  agent_connected: Bot,
  agent_disconnected: Bot,
  channel_mention: Bell,
  channel_attention_updated: Bell,
  msg_routed: MessageSquare,
  channel_created: Hash,
  channel_joined: Hash,
  channel_left: Hash,
  channel_message: Hash,
  broadcast: Radio,
  presence_update: Radio,
  rpc_request: Zap,
  rpc_reply: Zap,
  rpc_timeout: Zap,
  event_published: Radio,
  change_feed_published: Database,
  intent_declared: Zap,
  context_translated: Zap,
  e2e_forwarded: Shield,
  acl_update: Shield,
  acl_denied: Shield,
  kv_set: Database,
  kv_delete: Database,
  skills_advertised: Cpu,
};

export const SIDEBAR_CHANNEL_HIGHLIGHT_ROW_CLASS_NAME =
  "app-channel-row group/channel-row relative my-1 flex h-8 w-full items-center gap-2 rounded px-2 text-left text-sidebar-foreground/75";

