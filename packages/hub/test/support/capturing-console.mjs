// Records console.error and console.warn for one async callback, then restores them.
export async function capturingConsole(callback) {
  const logged = { error: [], warn: [] };
  const previous = { error: console.error, warn: console.warn };
  console.error = (...args) => { logged.error.push(args); };
  console.warn = (...args) => { logged.warn.push(args); };
  try {
    await callback();
  } finally {
    console.error = previous.error;
    console.warn = previous.warn;
  }
  return logged;
}
