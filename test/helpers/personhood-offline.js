// Runs the personhood transaction builders offline against recorded runtime
// metadata: polkadot-api's offline API stands in for the chain, so the
// extension values pad captures come from papi itself.

import * as fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { getOfflineApi } from "polkadot-api";
import { Bytes, Tuple, decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";

export const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
export const PEOPLE_IDENTIFIER_HEX = "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652020202020";
const MEMBER_KEY_HEX = "0x" + "01".repeat(32);
const NOW_MS = 1_761_100_000_000n;
const PROOF = new Uint8Array(785).map((_, i) => i % 251);
const ALIAS = new Uint8Array(32).fill(0x0a);
const SIGNATURE = new Uint8Array(64).fill(0xaa);

/** Metadata V16 bytes of `test/fixtures/metadata/<name>.scale.gz`. */
export const loadMetadata = (name) =>
  new Uint8Array(gunzipSync(fs.readFileSync(new URL(`../fixtures/metadata/${name}.scale.gz`, import.meta.url))));

const offlineTx = async (metadata, pallet, call, args) => {
  const api = await getOfflineApi({ genesis: "0x" + "11".repeat(32), getMetadata: async () => metadata });
  const tx = api.tx[pallet][call](args);
  return {
    getEncodedData: async () => tx.encodedData,
    // The online API fills nonce and mortality from the chain.
    sign: (signer, options) => tx.sign(signer, { nonce: 0, mortality: { mortal: false }, ...options }),
  };
};

const capturingClient = (sink) => ({
  submitAndWatch: (bytes) => ({
    subscribe: ({ next }) => {
      sink.extrinsic = bytes;
      Promise.resolve().then(() => next({ type: "finalized", ok: true, block: { hash: "0x01" } }));
      return { unsubscribe: () => {} };
    },
  }),
});

/** `claimPgas` with fixed inputs; returns the submitted extrinsic and the proof message. */
export async function claimOffline(claimPgas, metadata) {
  const out = {};
  const claimTx = await offlineTx(metadata, "Pgas", "claim_pgas", { slot_index: 0, target: ALICE });
  const ahUnsafeApi = {
    constants: {
      AliasAccounts: {
        PeopleCollectionIdentifier: async () => PEOPLE_IDENTIFIER_HEX,
        PeopleRingExponent: async () => ({ type: "R2e9" }),
      },
      Pgas: { PgasClaimAmount: async () => 1_000n },
    },
    query: {
      Timestamp: { Now: { getValue: async () => NOW_MS } },
      Assets: { Asset: { getValue: async () => ({}) } },
      MembersSubscriber: {
        CurrentGeneration: { getValue: async () => 0 },
        RingRoots: { getValue: async () => [{ revision: 1, root: new Uint8Array(32) }] },
      },
    },
    tx: { Pgas: { claim_pgas: () => claimTx } },
  };
  const peopleUnsafeApi = {
    query: {
      Members: {
        Members: { getValue: async () => ({ type: "Included", value: { ring_index: 0, ring_page: 0 } }) },
        RingKeys: { getEntries: async () => [{ keyArgs: [PEOPLE_IDENTIFIER_HEX, 0, 0], value: [MEMBER_KEY_HEX] }] },
      },
    },
  };
  await claimPgas({
    peopleUnsafeApi,
    ahUnsafeApi,
    ahClient: capturingClient(out),
    target: ALICE,
    memberKey: new Uint8Array(32).fill(1),
    buildRingProof: async ({ msg }) => {
      out.implication = msg;
      return { proof: PROOF, alias: ALIAS };
    },
    validateWithCommitment: () => ALIAS,
  });
  return out;
}

/** `bindPersonalIdToAccount` with fixed inputs; returns the submitted extrinsic and the signed message. */
export async function bindOffline(bindPersonalIdToAccount, metadata) {
  const out = {};
  const args = { account: ALICE, call_valid_at: 100 };
  const bindTx = await offlineTx(metadata, "People", "set_personal_id_account", args);
  const typedApi = {
    tx: { People: { set_personal_id_account: () => bindTx } },
    query: { System: { Number: { getValue: async () => 100 } } },
  };
  await bindPersonalIdToAccount({
    typedApi,
    client: capturingClient(out),
    personalId: 7n,
    account: ALICE,
    callValidAt: 100,
    signMember: (msg) => {
      out.implication = msg;
      return SIGNATURE;
    },
  });
  return out;
}

/**
 * Decode a V5 General extrinsic with the codecs of the pipeline named by its own
 * version byte. `active` lists the extensions whose value is not their "off"
 * form (None, false, or a Disabled/None variant).
 */
export function decodeGeneralExtrinsic(metadata, extrinsic) {
  const meta = unifyMetadata(decAnyMetadata(metadata));
  const lookup = getLookupFn(meta);
  const builder = getDynamicBuilder(lookup);
  const body = Bytes().dec(extrinsic);
  if (body[0] !== 0x45) throw new Error(`not a V5 General extrinsic: 0x${body[0].toString(16)}`);
  const version = body[1];
  const pipeline = meta.extrinsic.signedExtensions[version];
  if (!pipeline) throw new Error(`no extension pipeline v${version}`);
  const codec = Tuple(...pipeline.map((e) => builder.buildDefinition(e.type)), builder.buildDefinition(lookup.call));
  // Decode from a copy: papi's decoders misread a subarray view.
  const rest = body.slice(2);
  const decoded = codec.dec(rest);
  const reencoded = codec.enc(decoded);
  const call = decoded.at(-1);
  const active = pipeline
    .filter((e, i) => {
      const type = lookup(e.type);
      const value = decoded[i];
      if (type.type === "option") return value !== undefined;
      if (type.type === "primitive" && type.value === "bool") return value === true;
      if (type.type === "enum" && ("Disabled" in type.value || "None" in type.value)) {
        return value.type !== "Disabled" && value.type !== "None";
      }
      return false;
    })
    .map((e) => e.identifier);
  return {
    version,
    order: pipeline.map((e) => e.identifier),
    active,
    call: `${call.type}.${call.value.type}`,
    consumedAll: reencoded.length === rest.length && reencoded.every((b, i) => b === rest[i]),
  };
}
