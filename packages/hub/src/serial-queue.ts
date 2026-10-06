/** Runs operations one after another; a failed one does not stop the next. */
export function serialQueue(): (operation: () => Promise<void>) => Promise<void> {
  let pending: Promise<void> = Promise.resolve();
  return (operation) => {
    const next = pending.then(operation);
    pending = next.catch(() => {});
    return next;
  };
}
