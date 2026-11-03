// Capture the signed-extension bytes papi computes for a tx, without signing it.

import { withCommonExtensions, withNonce } from "@polkadot-api/signers-common";
import {
  extensionValuesFromPayload,
  hexToBytes,
  type ExtensionValues,
} from "./encoding.js";

export interface CapturedExtensions {
  callData: Uint8Array;
  extensions: ExtensionValues;
}

interface CapturableTx {
  create: (creator: unknown, options: never) => Promise<Uint8Array>;
}

type CustomSignedExtensions = Record<string, { value: unknown; additionalSigned?: unknown }>;

/**
 * Run papi's enhancer chain over `tx` and abort before it signs, keeping the
 * bytes the enhancers produced for the extension pipeline that contains
 * `required`. Nothing is submitted, and CheckNonce does not
 * apply to the General extrinsics this captures, so the nonce is pinned to 0:
 * withNonce would otherwise wait for finalization and make a runtime call for
 * the all-zero dummy account on every pass. Returns null if papi never reached
 * the creator.
 */
export const captureExtensions = async (
  tx: CapturableTx,
  options: { customSignedExtensions?: CustomSignedExtensions } & Record<string, unknown>,
  required: string,
): Promise<CapturedExtensions | null> => {
  let captured: CapturedExtensions | null = null;
  const sentinel = new Error("__extension_capture_sentinel__");
  const creator = withNonce(new Uint8Array(32))(
    withCommonExtensions(async (payload) => {
      captured = {
        callData: hexToBytes(payload.callData),
        extensions: await extensionValuesFromPayload(payload, required, options.customSignedExtensions ?? {}),
      };
      throw sentinel;
    }),
  );
  try {
    await tx.create(creator, { nonce: 0, ...options } as never);
  } catch (err) {
    if (err !== sentinel) throw err;
  }
  return captured;
};
