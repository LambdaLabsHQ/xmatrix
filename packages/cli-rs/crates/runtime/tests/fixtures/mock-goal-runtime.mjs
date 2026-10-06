import readline from "node:readline";
import { execFile } from "node:child_process";

const provider = process.argv[2];
let codexGoal = null;
let claudeGoal = null;
let zcodeGoal = null;
let grokGoal = null;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(message, result) {
  send({ jsonrpc: "2.0", id: message.id, result });
}

function goalSnapshot(goal) {
  return {
    response: goal ? `Goal ${goal.status}: ${goal.objective}` : "No goal set.",
    startedTurn: false,
    snapshot: {
      session: { target: goal },
      goalStats: {
        tokenBudget: 4096,
        tokensUsed: 512,
        timeUsedSeconds: 31,
        iterationCount: 4,
        contextUsed: 768,
        toolCallCount: 3,
      },
      runtime: {
        goalVerifications: [
          { reason: "fixture verification", nextAction: "fixture next action" },
        ],
      },
    },
  };
}

function handleCodexSessionRequest(message) {
  if (message.method === "initialize") {
    response(message, {});
    return true;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    if (Object.hasOwn(message.params ?? {}, "developerInstructions")) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "xMatrix bootstrap must not use developerInstructions" },
      });
      return true;
    }
    response(message, {
      thread: { id: "codex-fixture-thread", model: "gpt-fixture" },
    });
    return true;
  }
  return false;
}

function sendCodexTurnStarted(threadId, turnId) {
  send({
    method: "thread/status/changed",
    params: { threadId, status: { type: "active", activeFlags: [] } },
  });
  send({
    method: "turn/started",
    params: { threadId, turn: { id: turnId } },
  });
}

function sendCodexTurnOutput(threadId, turnId, id, text) {
  send({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: { id, type: "agentMessage", phase: "final_answer", text },
    },
  });
}

function sendCodexTurnCompleted(threadId, turnId) {
  send({
    method: "thread/status/changed",
    params: { threadId, status: { type: "idle" } },
  });
  send({
    method: "turn/completed",
    params: {
      threadId,
      turn: { id: turnId, status: "completed", items: [] },
    },
  });
}

function handleCodex(message) {
  if (handleCodexSessionRequest(message)) return;
  switch (message.method) {
    case "thread/goal/set": {
      const previous = codexGoal ?? {};
      codexGoal = {
        ...previous,
        ...message.params,
        threadId: undefined,
        updatedAt: "1700000000000",
        tokenBudget: message.params.tokenBudget ?? previous.tokenBudget ?? 4096,
        tokensUsed: 512,
        timeUsedSeconds: 31,
        iterationCount: 4,
        contextUsed: 768,
        toolCallCount: 3,
        reason: "fixture verification",
        nextAction: "fixture next action",
      };
      response(message, { goal: codexGoal });
      break;
    }
    case "thread/goal/get":
      response(message, { goal: codexGoal });
      break;
    case "thread/goal/clear":
      codexGoal = null;
      response(message, { cleared: true, goal: null });
      break;
    default:
      if (message.id !== undefined) response(message, {});
  }
}

function handleCodexTurnOrder(message) {
  if (handleCodexSessionRequest(message)) return;
  switch (message.method) {
    case "turn/start": {
      const threadId = message.params.threadId;
      const turnId = "codex-fixture-turn";
      response(message, { turn: { id: turnId } });
      sendCodexTurnStarted(threadId, turnId);
      sendCodexTurnOutput(
        threadId,
        turnId,
        "codex-fixture-message",
        "fixture complete"
      );
      // Codex app-server publishes the idle thread status before the terminal
      // turn notification. Clients must treat turn/completed as authoritative
      // instead of waiting for another idle notification that will not arrive.
      sendCodexTurnCompleted(threadId, turnId);
      break;
    }
    default:
      if (message.id !== undefined) response(message, {});
  }
}

function handleCodexTurnFailure(message) {
  if (handleCodexSessionRequest(message)) return;
  if (message.method !== "turn/start") {
    if (message.id !== undefined) response(message, {});
    return;
  }
  const threadId = message.params.threadId;
  const turnId = "codex-fixture-failed-turn";
  response(message, { turn: { id: turnId } });
  sendCodexTurnStarted(threadId, turnId);
  for (const params of [
    { message: "Reconnecting... 1/5" },
    { threadId: "unrelated-thread", turnId, message: "Unrelated failure" },
    {
      threadId,
      turnId,
      error: {
        message: "This request was blocked by our safety systems. Reason: Potentially unintended activity.",
      },
    },
  ]) {
    send({ method: "error", params });
  }
}

function handleCodexInterruptWithoutCompletion(message) {
  if (handleCodexSessionRequest(message)) return;
  switch (message.method) {
    case "turn/start": {
      const threadId = message.params.threadId;
      const turnId = "codex-fixture-interrupted-turn";
      response(message, { turn: { id: turnId } });
      sendCodexTurnStarted(threadId, turnId);
      break;
    }
    case "turn/interrupt":
      response(message, {});
      send({
        method: "thread/status/changed",
        params: { threadId: message.params.threadId, status: { type: "idle" } },
      });
      // Some Codex app-server versions do not emit turn/completed after an
      // interrupted turn. The wrapper must still yield to the new message.
      break;
    default:
      if (message.id !== undefined) response(message, {});
  }
}

function handleCodexInterruptWithoutAck(message) {
  if (handleCodexSessionRequest(message)) return;
  switch (message.method) {
    case "turn/start": {
      const threadId = message.params.threadId;
      const turnId = "codex-fixture-unresponsive-interrupt-turn";
      response(message, { turn: { id: turnId } });
      sendCodexTurnStarted(threadId, turnId);
      break;
    }
    case "turn/interrupt":
      // Simulate a wedged provider. xMatrix must retain its hard-shutdown
      // fallback instead of waiting forever for Codex to become idle.
      break;
    default:
      if (message.id !== undefined) response(message, {});
  }
}

function handleCodexSessionRateLimitTurn(message) {
  if (handleCodexSessionRequest(message)) return;
  switch (message.method) {
    case "turn/start": {
      const threadId = message.params.threadId;
      const turnId = "codex-fixture-session-rate-limit-turn";
      response(message, { turn: { id: turnId } });
      sendCodexTurnStarted(threadId, turnId);
      // This is the app-server's session-local value. It must never become the
      // channel's Codex quota meter, even when an activity event follows it.
      send({
        method: "turn/updated",
        params: {
          threadId,
          turnId,
          turn: {
            rateLimitsByLimitId: {
              codex: {
                limitId: "codex",
                limitName: "Codex",
                primary: { usedPercent: 100, windowDurationMins: 300 },
                secondary: { usedPercent: 65, windowDurationMins: 10080 },
              },
            },
          },
        },
      });
      send({
        method: "thread/status/changed",
        params: { threadId, status: { type: "active", activeFlags: [] } },
      });
      sendCodexTurnOutput(
        threadId,
        turnId,
        "codex-fixture-session-rate-limit-message",
        "session rate limit fixture complete"
      );
      sendCodexTurnCompleted(threadId, turnId);
      break;
    }
    default:
      if (message.id !== undefined) response(message, {});
  }
}

function handleCodexRedirectedTurn(message) {
  if (handleCodexSessionRequest(message)) return;
  switch (message.method) {
    case "turn/start": {
      const originalThreadId = message.params.threadId;
      const redirectedThreadId = "codex-fixture-thread-after-resume";
      const turnId = "codex-fixture-redirected-turn";
      response(message, { turn: { id: turnId } });
      sendCodexTurnStarted(originalThreadId, turnId);
      sendCodexTurnOutput(
        redirectedThreadId,
        turnId,
        "codex-fixture-redirected-message",
        "redirected fixture complete"
      );
      sendCodexTurnCompleted(redirectedThreadId, turnId);
      break;
    }
    default:
      if (message.id !== undefined) response(message, {});
  }
}

function handleCodexGoalTurnOrder(message) {
  if (handleCodexSessionRequest(message)) return;
  switch (message.method) {
    case "thread/goal/set":
      codexGoal = {
        objective: message.params.objective ?? codexGoal?.objective,
        status: message.params.status ?? codexGoal?.status ?? "active",
        active: (message.params.status ?? "active") === "active",
      };
      response(message, { goal: codexGoal });
      break;
    case "thread/goal/get":
      response(message, { goal: codexGoal });
      break;
    case "turn/start": {
      const threadId = message.params.threadId;
      const firstTurnId = "codex-fixture-goal-turn-1";
      const secondTurnId = "codex-fixture-goal-turn-2";
      response(message, { turn: { id: firstTurnId } });
      sendCodexTurnStarted(threadId, firstTurnId);
      sendCodexTurnOutput(
        threadId,
        firstTurnId,
        "codex-fixture-goal-message-1",
        "intermediate goal output"
      );
      sendCodexTurnCompleted(threadId, firstTurnId);
      sendCodexTurnStarted(threadId, secondTurnId);
      codexGoal = { ...codexGoal, status: "complete", active: false };
      send({
        method: "thread/goal/updated",
        params: { threadId, turnId: secondTurnId, goal: codexGoal },
      });
      sendCodexTurnOutput(
        threadId,
        secondTurnId,
        "codex-fixture-goal-message-2",
        "completed goal output"
      );
      sendCodexTurnCompleted(threadId, secondTurnId);
      break;
    }
    default:
      if (message.id !== undefined) response(message, {});
  }
}

function handleClaude(message) {
  if (message.type !== "user") return;
  const rawContent = message.message?.content ?? "";
  const content = Array.isArray(rawContent)
    ? rawContent
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
    : rawContent;
  let result = "fixture response";
  if (content.trim() === "/goal clear") {
    result = `Goal cleared: ${claudeGoal ?? "fixture goal"}`;
    claudeGoal = null;
  } else if (content.trim() === "/goal") {
    result = claudeGoal
      ? `Goal active: ${claudeGoal} (not yet evaluated)`
      : "No goal set.";
  } else if (content.startsWith("/goal ")) {
    claudeGoal = content.slice(6);
    result = `Goal active: ${claudeGoal} (not yet evaluated)`;
  }
  send({
    type: "system",
    subtype: "init",
    session_id: "claude-fixture-session",
    model: "claude-fixture",
    slash_commands: ["goal"],
  });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "claude-fixture-session",
    result,
    usage: { input_tokens: 8, output_tokens: 4 },
  });
}

function handleZcode(message) {
  switch (message.method) {
    case "session/create":
      response(message, {
        session: { sessionId: "zcode-fixture-session", target: null },
      });
      break;
    case "session/subscribe":
      response(message, {});
      break;
    case "session/goal": {
      const action = message.params?.action;
      if (action === "set" || action === "replace") {
        zcodeGoal = {
          objective: message.params.objective,
          status: "active",
          updatedAt: "1700000000000",
        };
      } else if (action === "pause" && zcodeGoal) {
        zcodeGoal = { ...zcodeGoal, status: "paused" };
      } else if (action === "resume" && zcodeGoal) {
        zcodeGoal = { ...zcodeGoal, status: "active" };
      } else if (action === "clear") {
        zcodeGoal = null;
      }
      response(message, goalSnapshot(zcodeGoal));
      break;
    }
    default:
      if (message.id !== undefined) response(message, {});
  }
}

function handleGrok(message) {  switch (message.method) {
    case "initialize":
    case "authenticate":
      response(message, {});
      break;
    case "session/new":
    case "session/load":
      response(message, {
        sessionId: "grok-fixture-session",
        models: {
          currentModelId: "grok-fixture",
          availableModels: [
            { modelId: "grok-fixture", displayName: "Grok Fixture" },
          ],
        },
      });
      break;
    case "session/prompt": {
      const text = message.params?.prompt?.[0]?.text ?? "";
      const command = text.trim();
      if (command === "/goal clear") {
        grokGoal = null;
      } else if (command === "/goal pause" && grokGoal) {
        grokGoal = { ...grokGoal, status: "paused" };
      } else if (command === "/goal resume" && grokGoal) {
        grokGoal = { ...grokGoal, status: "active" };
      } else if (command.startsWith("/goal ") && command !== "/goal status") {
        grokGoal = { objective: command.slice(6), status: "active" };
      }
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "grok-fixture-session",
          update: {
            sessionUpdate: "tool_call",
            title: "update_goal",
            rawInput: grokGoal ?? { status: "cleared" },
          },
        },
      });
      response(message, { stopReason: "end_turn", _meta: { modelId: "grok-fixture" } });
      break;
    }
    default:
      if (message.id !== undefined) response(message, {});
  }
}

// Generic ACP provider mirroring the Kimi Code `kimi acp` wire shape
// (measured on kimi 0.30.0): configOptions instead of a models catalog,
// kind-tagged permission options, and no authenticate call from the client.
const acpState = { authenticateSeen: false, promptId: null };

function completeAcpPrompt(message, text) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "acp-fixture-session", update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text },
    } },
  });
  response(message, { stopReason: "end_turn",
    _meta: { usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 } } });
}

function completeLiveCanaryPrompt(message) {
  const binary = process.argv[3];
  const hubUrl = process.env.XMATRIX_HUB_URL;
  const channelId = process.env.XMATRIX_AUTO_JOIN_CHANNEL_ID;
  const initialMessage = process.env.XMATRIX_INITIAL_MESSAGE || "";
  const reply = initialMessage.match(/Reply exactly:\s*(.+)$/mu)?.[1]?.trim() ||
    "xMatrix Agent Launch live canary reply";
  if (!binary || !hubUrl || !channelId) {
    send({ jsonrpc: "2.0", id: message.id,
      error: { code: -32000, message: "live canary spawn context is incomplete" } });
    return;
  }
  execFile(binary, ["--hub-url", hubUrl, "send", channelId, reply], {
    env: process.env, timeout: 15_000,
  }, (error, stdout, stderr) => {
    if (error) {
      const clean = (value) => String(value || "")
        .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
        .replace(/eyJ[A-Za-z0-9._-]{20,}/gu, "[redacted-token]")
        .replace(/[\r\n\t]+/gu, " ").slice(0, 2_000);
      process.stderr.write(`live canary nested send failed: code=${clean(error.code)} ` +
        `signal=${clean(error.signal)} stdout=${clean(stdout)} stderr=${clean(stderr)}\n`);
      send({ jsonrpc: "2.0", id: message.id,
        error: { code: -32000, message: `live canary send failed: ${error.message}` } });
      return;
    }
    completeAcpPrompt(message, reply);
  });
}

function handleAcp(message) {
  // Client -> server response to our session/request_permission.
  if (message.method === undefined) {
    if (message.id === 900 && acpState.promptId !== null) {
      const optionId = message.result?.outcome?.optionId ?? "<none>";
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "acp-fixture-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `fixture acp reply (perm:${optionId},auth:${acpState.authenticateSeen})`,
            },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "acp-fixture-session",
          update: {
            sessionUpdate: "usage_update",
            used: 8192,
            size: 131072,
            cost: { amount: 0.0042, currency: "USD" },
          },
        },
      });
      send({
        jsonrpc: "2.0",
        id: acpState.promptId,
        result: {
          stopReason: "end_turn",
          _meta: { usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 } },
        },
      });
      acpState.promptId = null;
    }
    return;
  }
  switch (message.method) {
    case "initialize":
      response(message, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
          mcpCapabilities: { http: true, sse: true },
          sessionCapabilities: { list: {}, resume: {} },
        },
        authMethods: [{ id: "login", name: "Login", description: "fixture login" }],
        agentInfo: { name: "Kimi Code CLI", version: "0.30.0" },
      });
      break;
    case "authenticate":
      acpState.authenticateSeen = true;
      response(message, {});
      break;
    case "session/new":
      response(message, {
        sessionId: "acp-fixture-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "kimi-fixture",
            options: [{ value: "kimi-fixture", name: "Kimi Fixture" }],
          },
          {
            id: "thinking",
            name: "Thinking",
            type: "select",
            currentValue: "high",
            options: [
              { value: "off", name: "Off" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "mode",
            name: "Mode",
            type: "select",
            currentValue: "default",
            options: [{ value: "default", name: "Default" }],
          },
        ],
      });
      break;
    case "session/load":
      response(message, { sessionId: "acp-fixture-session" });
      break;
    case "session/prompt": {
      if (provider === "acp-live-canary") {
        completeLiveCanaryPrompt(message);
        break;
      }
      acpState.promptId = message.id;
      // Kimi-measured permission request: kind-tagged options.
      send({
        jsonrpc: "2.0",
        id: 900,
        method: "session/request_permission",
        params: {
          sessionId: "acp-fixture-session",
          toolCall: { toolCallId: "tc-1", title: "Write file", content: [] },
          options: [
            { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
            { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      });
      break;
    }
    case "session/cancel":
      break;
    default:
      if (message.id !== undefined) response(message, {});
  }
}

const handlers = {
  codex: handleCodex,
  "codex-turn-order": handleCodexTurnOrder,
  "codex-turn-failure": handleCodexTurnFailure,
  "codex-interrupt-no-completion": handleCodexInterruptWithoutCompletion,
  "codex-interrupt-no-ack": handleCodexInterruptWithoutAck,
  "codex-session-rate-limit-turn": handleCodexSessionRateLimitTurn,
  "codex-redirected-turn": handleCodexRedirectedTurn,
  "codex-goal-turn-order": handleCodexGoalTurnOrder,
  claude: handleClaude,
  zcode: handleZcode,
  grok: handleGrok,
  acp: handleAcp,
  "acp-live-canary": handleAcp,
};

if (!handlers[provider]) {
  process.stderr.write(`unknown provider fixture: ${provider ?? "<missing>"}\n`);
  process.exit(2);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  handlers[provider](JSON.parse(line));
});
