import type { Dispatch, SetStateAction } from "react";
import type {
  AutomationUpdateRequest,
  SerializedAutomation,
} from "@xmatrix/protocol";
import {
  fetchAutomation,
  patchAutomation,
  removeAutomation,
  replaceAutomation,
  setAutomationPaused,
  sortAutomations,
} from "./workspace-shell-modules";
import { pageApi } from "../../lib/pages/page-client";
import { XMatrixApiError } from "../../lib/query/api-client";
import { UserFacingProblem, userErrorMessage } from "../../lib/user-facing-error";

type AutomationActionState = {
  token: string | null | undefined;
  currentSpaceId: string | null | undefined;
  automations: SerializedAutomation[];
  busy: string | null;
  setAutomations: Dispatch<SetStateAction<SerializedAutomation[]>>;
  setBusy: Dispatch<SetStateAction<string | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
};


export function useWorkspaceAutomationActions(state: AutomationActionState) {
  /**
   * A version conflict means this list is behind the Hub, as when a realtime
   * push was missed. Read the Automation again and show it, and return it only
   * when it did move on, so the caller can decide whether its action still
   * applies. Null means it is gone.
   */
  async function reread(token: string, error: unknown, automation: SerializedAutomation) {
    if (!(error instanceof XMatrixApiError) || error.status !== 409) throw error;
    const fresh = await fetchAutomation(token, automation.id);
    state.setAutomations((current) => fresh
      ? sortAutomations(replaceAutomation(current, fresh))
      : current.filter((item) => item.id !== automation.id));
    if (fresh?.version === automation.version) throw error;
    return fresh;
  }

  async function toggleAutomation(automation: SerializedAutomation) {
    const token = state.token;
    if (!token || state.busy) return;
    state.setBusy(`toggle:${automation.id}`);
    state.setError(null);
    try {
      let updated: SerializedAutomation;
      try {
        updated = await setAutomationPaused(token, automation, automation.enabled);
      } catch (error) {
        const fresh = await reread(token, error, automation);
        if (!fresh) throw new UserFacingProblem("Automation is no longer available.");
        // Someone else already paused or resumed it: what was asked for holds.
        if (fresh.enabled !== automation.enabled) return;
        updated = await setAutomationPaused(token, fresh, fresh.enabled);
      }
      state.setAutomations((current) => sortAutomations(replaceAutomation(current, updated)));
    } catch (error) {
      state.setError(userErrorMessage(error, "Couldn't update the Automation"));
    } finally {
      state.setBusy(null);
    }
  }

  /** Makes a page Automation's next occurrence due now; its cadence stays. */
  async function runAutomation(automation: SerializedAutomation) {
    const token = state.token;
    const { spaceId, pageId } = automation;
    if (!token || state.busy || !spaceId || !pageId) return;
    state.setBusy(`run:${automation.id}`);
    state.setError(null);
    const run = (target: SerializedAutomation) => pageApi.changeAutomation(spaceId, pageId, token, target, "run");
    try {
      let response;
      try {
        response = await run(automation);
      } catch (error) {
        const fresh = await reread(token, error, automation);
        if (!fresh) throw new UserFacingProblem("Automation is no longer available.");
        response = await run(fresh);
      }
      const updated = response.automation;
      if (!updated) throw new UserFacingProblem("Automation is no longer available.");
      state.setAutomations((current) => sortAutomations(replaceAutomation(current, updated)));
    } catch (error) {
      state.setError(userErrorMessage(error, "Couldn't run the Automation"));
    } finally {
      state.setBusy(null);
    }
  }

  async function updateAutomation(
    automationId: string,
    input: Omit<AutomationUpdateRequest, "expectedVersion">
  ) {
    const token = state.token;
    if (!token || state.busy) return;
    state.setBusy(`edit:${automationId}`);
    state.setError(null);
    try {
      const current = state.automations.find((automation) => automation.id === automationId);
      if (!current) throw new UserFacingProblem("Automation is no longer available.");
      // An edit is never retried: it would overwrite the change it conflicted with.
      const updated = await patchAutomation(token, automationId, {
        ...input,
        expectedVersion: current.version,
      }).catch(async (error: unknown) => {
        await reread(token, error, current);
        throw error;
      });
      // Another author's evaluation comes back as the editor's replacement under a new id.
      state.setAutomations((automations) => sortAutomations(replaceAutomation(
        automations.filter((automation) => automation.id !== automationId || automation.id === updated.id),
        updated,
      )));
    } catch (error) {
      state.setError(userErrorMessage(error, "Couldn't update the Automation"));
    } finally {
      state.setBusy(null);
    }
  }

  async function deleteAutomation(automation: SerializedAutomation) {
    const token = state.token;
    if (!token || state.busy) return;
    if (!window.confirm(`Delete evaluator lineage "${automation.name}" and all of its child evaluations?`)) return;
    state.setBusy(`delete:${automation.id}`);
    state.setError(null);
    try {
      // The person confirmed deleting this lineage, whatever version it has reached.
      await removeAutomation(token, automation).catch(async (error: unknown) => {
        const fresh = await reread(token, error, automation);
        if (fresh) await removeAutomation(token, fresh);
      });
      const lineageRoot = automation.input?.lineage?.rootMessageId;
      state.setAutomations((automations) => automations.filter((item) =>
        lineageRoot ? item.input?.lineage?.rootMessageId !== lineageRoot : item.id !== automation.id
      ));
    } catch (error) {
      state.setError(userErrorMessage(error, "Couldn't delete the evaluator lineage"));
    } finally {
      state.setBusy(null);
    }
  }

  return {
    toggleAutomation,
    runAutomation,
    updateAutomation,
    deleteAutomation,
  };
}
