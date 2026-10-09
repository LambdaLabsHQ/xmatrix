import type { Dispatch, SetStateAction } from "react";
import type {
  AutomationUpdateRequest,
  SerializedAutomation,
} from "@xmatrix/protocol";
import {
  patchAutomation,
  removeAutomation,
  replaceAutomation,
  setAutomationPaused,
  sortAutomations,
} from "./workspace-shell-modules";
import { pageApi } from "../../lib/pages/page-client";
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
  async function toggleAutomation(automation: SerializedAutomation) {
    if (!state.token || state.busy) return;
    state.setBusy(`toggle:${automation.id}`);
    state.setError(null);
    try {
      const updated = await setAutomationPaused(state.token, automation, automation.enabled);
      state.setAutomations((current) => sortAutomations(replaceAutomation(current, updated)));
    } catch (error) {
      state.setError(userErrorMessage(error, "Couldn't update the Automation"));
    } finally {
      state.setBusy(null);
    }
  }

  /** Makes a page Automation's next occurrence due now; its cadence stays. */
  async function runAutomation(automation: SerializedAutomation) {
    if (!state.token || state.busy) return;
    if (!automation.spaceId || !automation.pageId) return;
    state.setBusy(`run:${automation.id}`);
    state.setError(null);
    try {
      const { automation: updated } = await pageApi.changeAutomation(automation.spaceId, automation.pageId,
        state.token, automation, "run");
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
    if (!state.token || state.busy) return;
    state.setBusy(`edit:${automationId}`);
    state.setError(null);
    try {
      const current = state.automations.find((automation) => automation.id === automationId);
      if (!current) throw new UserFacingProblem("Automation is no longer available.");
      const updated = await patchAutomation(state.token, automationId, {
        ...input,
        expectedVersion: current.version,
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
    if (!state.token || state.busy) return;
    if (!window.confirm(`Delete evaluator lineage "${automation.name}" and all of its child evaluations?`)) return;
    state.setBusy(`delete:${automation.id}`);
    state.setError(null);
    try {
      await removeAutomation(state.token, automation);
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
