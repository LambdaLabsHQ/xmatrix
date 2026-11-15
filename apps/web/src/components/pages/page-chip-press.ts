/** A status line under the page's text opens the conversation behind it when pressed, and is inert without one. */
export function pressOpens(status: HTMLButtonElement, conversationId: string | undefined, title: string,
  openConversation: (conversationId: string) => void): void {
  if (!conversationId) { status.disabled = true; return; }
  status.title = title;
  // The press must not move the editor's selection.
  status.addEventListener("mousedown", (event) => event.preventDefault());
  status.addEventListener("click", () => openConversation(conversationId));
}
