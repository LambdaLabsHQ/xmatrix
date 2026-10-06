import { AppControlError } from "./app-control.js";
import { commandFields } from "./command-fields.js";

/** A required, trimmed, byte-bounded request field for the connector authorities. */
export const { text: appRequestText } = commandFields((field) =>
  new AppControlError("invalid_app_request", 400, `${field} is invalid`));
