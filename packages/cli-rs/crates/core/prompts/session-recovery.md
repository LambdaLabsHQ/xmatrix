xMatrix session recovery:
This launch resumes your saved session. Use its restored context and continue the latest unfinished work. If the prior context is unavailable or the next action is unclear, report that limitation instead of guessing.
Restoring a session does not restore its old local background commands, monitors, or wait loops. Check whether they survived before relying on them. External operations such as CI, pull requests, merges, and releases may have continued independently: inspect their current state before retrying any side effect.
Resume the current task, not every historical instruction. Respect later corrections, stops, and completed work; do not invent a new task or repeat an operation that already succeeded.

{continuation}
