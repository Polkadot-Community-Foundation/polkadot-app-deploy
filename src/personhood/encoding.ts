// Encoding utilities for V5 General extrinsics and ring-VRF proofs.
// Ported from the citizenship monorepo (pb-encoding.ts). Self-contained:
// only deps are @noble/hashes, @polkadot-api/substrate-bindings,
// @polkadot-api/metadata-builders, polkadot-api.

import { blake2b } from "@noble/hashes/blake2b";

export type EncodedExtension = { value: Uint8Array; additionalSigned: Uint8Array };

export type ExtensionValues = {
  /** Extension version of the pipeline below. */
  version: number;
  /** Identifiers of that pipeline, in order. */
  order: string[];
  /** Per-identifier explicit + implicit bytes. */
  byIdentifier: Record<string, EncodedExtension>;
};

export const concatBytes = (...arrays: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
};

/** SCALE compact-encode a non-negative integer (length-prefix use only). */
export const compactEncode = (n: number): Uint8Array => {
  if (n < 0) throw new Error("compactEncode: negative");
  if (n < 64) return new Uint8Array([n << 2]);
  if (n < 16384) {
    const v = (n << 2) | 0b01;
    return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  }
  if (n < 1073741824) {
    const v = (n << 2) | 0b10;
    return new Uint8Array([
      v & 0xff,
      (v >> 8) & 0xff,
      (v >> 16) & 0xff,
      (v >>> 24) & 0xff,
    ]);
  }
  throw new Error("compactEncode: value too large for inline path");
};

export const blake2_256 = (data: Uint8Array): Uint8Array =>
  blake2b(data, { dkLen: 32 });

/**
 * Build the bytes the runtime hashes for `AsPersonalIdentityWithProof`.
 *
 * msg = blake2_256( encode((ext_version, &call), &rest_ext, &rest_ext.implicit()) )
 *
 * `ext_version` is the extension version of the V5 General transaction.
 */
export const buildImplicationMessage = (
  callBytes: Uint8Array,
  extensions: ExtensionValues,
  excludeIdentifiers: string | Set<string>,
): Uint8Array => {
  const exclude =
    typeof excludeIdentifiers === "string"
      ? new Set([excludeIdentifiers])
      : excludeIdentifiers;
  const restExplicit: Uint8Array[] = [];
  const restImplicit: Uint8Array[] = [];
  for (const id of extensions.order) {
    if (exclude.has(id)) continue;
    const ext = extensions.byIdentifier[id];
    if (!ext) throw new Error(`buildImplication: missing extension '${id}'`);
    restExplicit.push(ext.value);
    restImplicit.push(ext.additionalSigned);
  }
  const implication = concatBytes(
    new Uint8Array([extensions.version]),
    callBytes,
    ...restExplicit,
    ...restImplicit,
  );
  return blake2_256(implication);
};

/**
 * Build the V5 General extrinsic wire bytes:
 *
 *   compactLen( 0x45 || ext_version || concat(all_explicit) || callBytes )
 *
 * `0x45` = version 5 + type General (`5 + (1 << 6)`).
 */
export const buildV5GeneralExtrinsic = (
  callBytes: Uint8Array,
  extensions: ExtensionValues,
): Uint8Array => {
  const explicit = extensions.order.map((id) => {
    const ext = extensions.byIdentifier[id];
    if (!ext) throw new Error(`buildV5General: missing extension '${id}'`);
    return ext.value;
  });
  const body = concatBytes(
    new Uint8Array([0x45]),
    new Uint8Array([extensions.version]),
    ...explicit,
    callBytes,
  );
  return concatBytes(compactEncode(body.length), body);
};

export const toHex = (bytes: Uint8Array): `0x${string}` => {
  let hex = "0x";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex as `0x${string}`;
};

/**
 * Convert a hex string (with or without 0x prefix) to Uint8Array. Buffer.from
 * stops at the first non-hex character and drops an odd trailing nibble, so
 * validate first: a silently shortened proof context reaches the chain as a bad
 * proof instead of failing here.
 */
export const hexToBytes = (hex: string): Uint8Array => {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error(`not a hex string: ${hex.length > 48 ? hex.slice(0, 48) + "..." : hex}`);
  }
  return new Uint8Array(Buffer.from(body, "hex"));
};

/** Convert Uint8Array to a lowercase 0x-prefixed hex string. */
export const bytesToHex = (b: Uint8Array): string =>
  "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** One transaction extension pipeline of a runtime. */
export interface ExtensionPipeline {
  version: number;
  order: string[];
  /** Encode an entry the way papi encodes custom extensions: a Uint8Array is taken as encoded. */
  encode: (identifier: string, entry: { value: unknown; additionalSigned?: unknown }) => EncodedExtension;
  /** The encoding of an extension that does nothing. Throws for types that have none. */
  inactive: (identifier: string) => EncodedExtension;
}

/**
 * Select the transaction extension pipeline for a transaction that needs the
 * `required` extension: the highest extension version whose pipeline contains
 * it. Metadata before V16 has one pipeline, version 0.
 *
 * `metadata` is the runtime metadata papi builds the transaction against. papi
 * encodes each extension from a single definition per identifier, so its values
 * can only be reused for extensions that pipeline 0 defines the same way; that
 * is checked here.
 */
export const selectExtensionPipeline = async (
  metadata: Uint8Array,
  required: string,
): Promise<ExtensionPipeline> => {
  const { decAnyMetadata, unifyMetadata } = await import(
    "@polkadot-api/substrate-bindings"
  );
  const { getDynamicBuilder, getLookupFn } = await import(
    "@polkadot-api/metadata-builders"
  );
  const meta = unifyMetadata(decAnyMetadata(metadata));
  const pipelines = Object.entries(meta.extrinsic.signedExtensions)
    .map(([version, entries]) => ({ version: Number(version), entries }))
    .sort((a, b) => b.version - a.version);
  const selected = pipelines.find(({ entries }) =>
    entries.some((e) => e.identifier === required),
  );
  if (!selected) {
    const listing = pipelines
      .map(({ version, entries }) => `v${version}: [${entries.map((e) => e.identifier).join(", ")}]`)
      .join("; ");
    throw new Error(`${required} is in no transaction extension pipeline of this runtime (${listing})`);
  }

  const v0 = meta.extrinsic.signedExtensions[0] ?? [];
  for (const entry of selected.entries) {
    const base = v0.find((e) => e.identifier === entry.identifier);
    if (base && (base.type !== entry.type || base.additionalSigned !== entry.additionalSigned)) {
      throw new Error(
        `transaction extension ${entry.identifier} is defined differently in pipelines 0 and ${selected.version}`,
      );
    }
  }

  const lookup = getLookupFn(meta);
  const builder = getDynamicBuilder(lookup);
  const entryOf = (identifier: string) => {
    const entry = selected.entries.find((e) => e.identifier === identifier);
    if (!entry) throw new Error(`transaction extension ${identifier} is not in pipeline ${selected.version}`);
    return entry;
  };
  const encodePart = (input: unknown, typeId: number): Uint8Array =>
    input instanceof Uint8Array ? input : builder.buildDefinition(typeId).enc(input);

  return {
    version: selected.version,
    order: selected.entries.map((e) => e.identifier),
    encode: (identifier, { value, additionalSigned }) => {
      const entry = entryOf(identifier);
      return {
        value: encodePart(value, entry.type),
        additionalSigned: encodePart(additionalSigned, entry.additionalSigned),
      };
    },
    inactive: (identifier) => {
      const entry = entryOf(identifier);
      if (lookup(entry.additionalSigned).type !== "void") {
        throw new Error(`transaction extension ${identifier} has an implicit, so it has no inactive encoding`);
      }
      const type = lookup(entry.type);
      let value: Uint8Array | undefined;
      if (type.type === "void") {
        value = new Uint8Array();
      } else if (type.type === "option" || (type.type === "primitive" && type.value === "bool")) {
        value = new Uint8Array([0]);
      } else if (type.type === "enum") {
        const off = Object.entries(type.value).find(
          ([name, variant]) => (name === "Disabled" || name === "None") && variant.type === "void",
        );
        if (off) value = new Uint8Array([off[1].idx]);
      }
      if (!value) {
        throw new Error(`transaction extension ${identifier} (${type.type}) has no inactive encoding`);
      }
      return { value, additionalSigned: new Uint8Array() };
    },
  };
};

/**
 * The values of `pipeline`'s extensions. Each comes from papi's capture, with
 * the custom entries applied; else from the caller's custom entry; else from
 * the extension's inactive encoding.
 */
export const fillExtensionValues = (
  pipeline: ExtensionPipeline,
  produced: Record<string, EncodedExtension | undefined>,
  customs: Record<string, { value: unknown; additionalSigned?: unknown }>,
): ExtensionValues => {
  const byIdentifier: ExtensionValues["byIdentifier"] = {};
  for (const id of pipeline.order) {
    const ext = produced[id];
    byIdentifier[id] = ext
      ? { value: ext.value, additionalSigned: ext.additionalSigned }
      : customs[id]
        ? pipeline.encode(id, customs[id])
        : pipeline.inactive(id);
  }
  return { version: pipeline.version, order: pipeline.order, byIdentifier };
};

/**
 * SCALE-encode `Vec<[u8; 32]>` — the shape that `verifiablejs.one_shot(...)`
 * decodes as the ring members list. Each input must be exactly 32 bytes.
 * Encoded as: compact(len) || member[0] || member[1] || ...
 */
export const encodeMembers = (members: Uint8Array[]): Uint8Array => {
  for (const m of members) {
    if (m.length !== 32) throw new Error("member key must be 32 bytes");
  }
  return concatBytes(compactEncode(members.length), ...members);
};

type PayloadExtension = { id: string; extra: string; additionalSigned: string };

/**
 * Index a papi v3 payload's extension array by identifier. A duplicate id keeps
 * the first entry, which is what papi's own reader does (raw-tx-creator's
 * getExtensionData uses `find`), so the extrinsic body and the signed payload
 * stay in agreement.
 */
export const indexExtensions = (
  extensions: PayloadExtension[],
): Record<string, EncodedExtension> => {
  const byIdentifier: Record<string, EncodedExtension> = {};
  for (const ext of extensions) {
    if (ext.id in byIdentifier) continue;
    byIdentifier[ext.id] = {
      value: hexToBytes(ext.extra),
      additionalSigned: hexToBytes(ext.additionalSigned),
    };
  }
  return byIdentifier;
};

/**
 * Resolved extension bytes from a papi v3 `TxPayloadV1`, on the pipeline that
 * contains `required`. The payload's own array order is undefined, so the
 * pipeline order comes from metadata.
 */
let pipelineCache: { key: string; pipeline: ExtensionPipeline } | null = null;

export const extensionValuesFromPayload = async (
  payload: {
    context: { metadata: string };
    extensions: PayloadExtension[];
  },
  required: string,
  customs: Record<string, { value: unknown; additionalSigned?: unknown }>,
): Promise<ExtensionValues> => {
  // Decoding the runtime metadata is the expensive part and each flow captures
  // twice against the same chain, so keep the last decode.
  // Key on a digest, not the hex itself: the metadata runs to megabytes and the
  // cache would otherwise hold it for the life of the process.
  const key = `${required}:${toHex(blake2b(new TextEncoder().encode(payload.context.metadata), { dkLen: 16 }))}`;
  if (pipelineCache?.key !== key) {
    pipelineCache = { key, pipeline: await selectExtensionPipeline(hexToBytes(payload.context.metadata), required) };
  }
  return fillExtensionValues(pipelineCache.pipeline, indexExtensions(payload.extensions), customs);
};
