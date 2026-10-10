/* The boxes of a message row, a conversation row and a list row, each written
   once. The row that shows the content and the skeleton that stands in for it
   while it loads both read these, so a skeleton cannot drift from its row. */

export const MESSAGE_ROW_CLASS_NAME =
  "app-message-row group relative flex items-start gap-(--app-message-avatar-gap) px-5";
/** A row that opens with its sender's header; a continuation is `py-0.5`. */
export const MESSAGE_ROW_HEADED_CLASS_NAME = "pt-3 pb-0.5";
export const MESSAGE_AVATAR_SLOT_CLASS_NAME = "app-message-author-avatar relative mt-0.5 self-start";
export const MESSAGE_AVATAR_CLASS_NAME = "message-author-avatar size-9 min-h-9 min-w-9 max-h-9 max-w-9 p-0";
export const MESSAGE_COLUMN_CLASS_NAME = "min-w-0 flex-1";
export const MESSAGE_HEAD_CLASS_NAME = "app-message-head flex min-w-0 items-start gap-2";
/** As tall as the hover actions a sent message has beside its name. */
export const MESSAGE_HEAD_HEADED_CLASS_NAME = "md:min-h-7";
export const MESSAGE_META_CLASS_NAME =
  "app-message-meta flex min-h-6 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1";
export const MESSAGE_AUTHOR_NAME_CLASS_NAME = "app-message-author-name shrink-0 whitespace-nowrap text-[15px] font-black";
export const MESSAGE_TIMESTAMP_CLASS_NAME = "app-message-timestamp shrink-0 tabular-nums";
export const MESSAGE_HEADER_TIMESTAMP_CLASS_NAME = "shrink-0 text-xs text-muted-foreground";
export const RICH_MESSAGE_CLASS_NAME =
  "rich-message mt-0.5 min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-[15px] leading-5 text-foreground";
export const RICH_MESSAGE_PARAGRAPH_CLASS_NAME = "mt-1 whitespace-pre-wrap first:mt-0";

export const CHANNEL_CHAT_ROW_CLASS_NAME = "app-channel-row app-channel-chat-row app-list-row";
export const CHANNEL_ROW_TITLE_LINE_CLASS_NAME = "app-channel-row-title-line flex min-w-0 items-baseline gap-2";
export const CHANNEL_ROW_TITLE_CLASS_NAME = "app-channel-row-title flex min-w-0 flex-1 items-baseline";
export const CHANNEL_ROW_HASH_CLASS_NAME = "app-channel-row-hash shrink-0";
export const CHANNEL_ROW_NAME_CLASS_NAME = "app-channel-row-name app-list-row-title min-w-0 truncate";
export const CHANNEL_ROW_TIME_CLASS_NAME = "app-channel-row-time shrink-0 self-center";
export const CHANNEL_ROW_PREVIEW_LINE_CLASS_NAME = "app-channel-row-preview-line flex min-w-0 items-center gap-1.5";
export const CHANNEL_ROW_PREVIEW_CLASS_NAME = "app-channel-row-preview app-list-row-meta min-w-0 flex-1 truncate";

export const LIST_ROW_CLASS_NAME =
  "app-list-row relative flex w-full min-w-0 items-center gap-2.5 pl-[var(--app-list-row-start)] pr-[var(--app-list-row-end)] py-2.5 text-left";
export const LIST_ROW_LEADING_CLASS_NAME = "flex shrink-0 items-center";
/** Beside two lines of text the mark sits on the title line. */
export const LIST_ROW_LEADING_TWO_LINE_CLASS_NAME = "mt-[3px] self-start";
export const LIST_ROW_COPY_CLASS_NAME = "min-w-0 flex-1";
export const LIST_ROW_TITLE_LINE_CLASS_NAME = "flex min-w-0 items-baseline gap-2";
export const LIST_ROW_TITLE_CLASS_NAME = "app-list-row-title min-w-0 flex-1 truncate font-semibold";
export const LIST_ROW_META_CLASS_NAME = "app-list-row-meta block truncate text-xs text-muted-foreground";
