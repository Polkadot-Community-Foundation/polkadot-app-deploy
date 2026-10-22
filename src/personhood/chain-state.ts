// Asset Hub reads whose storage layout differs between runtime versions.

import { Enum } from "polkadot-api";

export interface RingRoot {
  revision: number;
  root: Uint8Array;
}

type AhStateApi = {
  query: {
    MembersSubscriber: {
      CurrentGeneration: { getValue: (opts?: { at: string }) => Promise<number> };
      RingRoots: {
        getValue: (...args: unknown[]) => Promise<RingRoot[] | undefined>;
      };
    };
    Parameters: {
      Parameters: {
        getValue: (
          key: unknown,
          opts?: { at: string },
        ) => Promise<{ value: { value: bigint } } | undefined>;
      };
    };
    AliasAccounts: {
      AliasFee: { getValue: (opts?: { at: string }) => Promise<bigint | undefined> };
    };
  };
};

/** papi's errors for a storage entry the runtime lacks or declares with another shape. */
const isUnavailableEntry = (err: unknown, entry: string): boolean =>
  err instanceof Error &&
  (err.message === `Runtime entry Storage(${entry}) not found` ||
    err.message === `Incompatible runtime entry Storage(${entry})`);

/**
 * Ring roots of `(collection, ringIndex)`. Current runtimes key them by
 * `(CurrentGeneration, collection, ringIndex)`; runtimes without
 * `CurrentGeneration` use `(collection, ringIndex)`.
 */
export async function readRingRoots(
  ahUnsafeApi: unknown,
  collection: string,
  ringIndex: number,
): Promise<RingRoot[] | undefined> {
  const subscriber = (ahUnsafeApi as AhStateApi).query.MembersSubscriber;
  let generation: number;
  try {
    generation = await subscriber.CurrentGeneration.getValue({ at: "best" });
  } catch (err) {
    if (!isUnavailableEntry(err, "MembersSubscriber.CurrentGeneration")) throw err;
    return subscriber.RingRoots.getValue(collection, ringIndex, { at: "best" });
  }
  return subscriber.RingRoots.getValue(generation, collection, ringIndex, { at: "best" });
}

/**
 * The alias registration fee, or `null` while registration is closed.
 * Current runtimes take it from the `Parameters(AliasAccounts(AliasFee))`
 * dynamic parameter, older ones from `AliasAccounts.AliasFee` storage.
 */
export async function readAliasFee(ahUnsafeApi: unknown): Promise<bigint | null> {
  const query = (ahUnsafeApi as AhStateApi).query;
  try {
    const param = await query.Parameters.Parameters.getValue(
      Enum("AliasAccounts", Enum("AliasFee")),
      { at: "best" },
    );
    return param?.value.value ?? null;
  } catch (err) {
    if (!isUnavailableEntry(err, "Parameters.Parameters")) throw err;
  }
  return (await query.AliasAccounts.AliasFee.getValue({ at: "best" })) ?? null;
}
