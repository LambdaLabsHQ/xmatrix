/** Close the scenario's Agent sockets before its daemon sockets, then stop its product worker. */
export async function stopAgentWorker(worker, ...connections) {
  for (const connection of connections) {
    if (connection) connection.ws.close();
  }
  await worker.stop();
}
