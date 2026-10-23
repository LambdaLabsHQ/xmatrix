import { XMATRIX_FACE_URL } from "@xmatrix/protocol";

// xMatrix speaks in a Channel only through system notices and cards, with
// its own face (protocol faces.ts), the path message history already stores.
export const XMATRIX_SYSTEM_AVATAR_URL = XMATRIX_FACE_URL;

export const XMATRIX_SYSTEM_LABEL = "xMatrix";
