// Personhood transactions on runtimes with versioned transaction extensions.
//
// Metadata fixtures (test/fixtures/metadata/, V16, gzipped):
//   *-paseo-2005004       Paseo Asset Hub / People, one extension pipeline (v0)
//   *-paseo-2005005       the same runtimes built from paseo-network/runtimes#452
//                         (pipelines v0 and v1)
//   *-next-paseo-3004000  Paseo Next (pipelines v0 and v1)

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { blake2b } from "@noble/hashes/blake2b";
import { Bytes } from "@polkadot-api/substrate-bindings";
import {
  buildImplicationMessage,
  buildV5GeneralExtrinsic,
  selectExtensionPipeline,
} from "../dist/personhood/encoding.js";
import { claimPgas } from "../dist/personhood/claim-pgas.js";
import { bindPersonalIdToAccount } from "../dist/personhood/bind-personal-id.js";
import { bindOffline, claimOffline, decodeGeneralExtrinsic, loadMetadata } from "./helpers/personhood-offline.js";

const RUNTIMES = [
  { name: "paseo-2005004", version: 0 },
  { name: "paseo-2005005", version: 1 },
  { name: "next-paseo-3004000", version: 1 },
];
const VERSIONED = RUNTIMES.filter((r) => r.version === 1);

const hex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");
const hash = (bytes) => hex(blake2b(bytes, { dkLen: 32 }));
const body = (extrinsic) => Bytes().dec(extrinsic).slice();

describe("selectExtensionPipeline", () => {
  for (const { name, version } of RUNTIMES) {
    test(`${name}: AsPgas and AsPerson select pipeline v${version}`, async () => {
      const ah = await selectExtensionPipeline(loadMetadata(`asset-hub-${name}`), "AsPgas");
      const people = await selectExtensionPipeline(loadMetadata(`people-${name}`), "AsPerson");
      assert.equal(ah.version, version);
      assert.equal(people.version, version);
      assert.ok(ah.order.includes("AsPgas"));
      assert.ok(people.order.includes("AsPerson"));
    });
  }

  test("an extension that no pipeline contains is an error listing every pipeline", async () => {
    await assert.rejects(
      selectExtensionPipeline(loadMetadata("people-paseo-2005005"), "AsPgas"),
      (err) =>
        /AsPgas is in no transaction extension pipeline/.test(err.message) &&
        /v0: \[AuthorizeCall/.test(err.message) &&
        /v1: \[UnitTransactionExtension/.test(err.message),
    );
  });

  test("inactive encodings follow the extension's type", async () => {
    const ah = await selectExtensionPipeline(loadMetadata("asset-hub-paseo-2005005"), "AsPgas");
    const inactive = (id) => hex(ah.inactive(id).value);
    assert.equal(inactive("UnitTransactionExtension"), "0x"); // void
    assert.equal(inactive("VerifyMultiSignature"), "0x00"); // enum, Disabled
    assert.equal(inactive("AsDotnsGateway"), "0x00"); // Option, None
    assert.equal(inactive("RestrictOrigins"), "0x00"); // bool
    assert.throws(() => ah.inactive("CheckGenesis"), /has an implicit/);
    assert.throws(() => ah.inactive("ChargeAssetTxPayment"), /has no inactive encoding/);
  });
});

describe("the extension version byte", () => {
  const call = new Uint8Array([0x32, 0x00, 0x01]);
  const extensions = (version) => ({
    version,
    order: ["RestrictOrigins"],
    byIdentifier: { RestrictOrigins: { value: new Uint8Array([0x01]), additionalSigned: new Uint8Array() } },
  });

  test("leads the implication", () => {
    assert.equal(
      hex(buildImplicationMessage(call, extensions(1), new Set())),
      hash(new Uint8Array([0x01, ...call, 0x01])),
    );
  });

  test("follows the General transaction header", () => {
    assert.equal(hex(buildV5GeneralExtrinsic(call, extensions(1))), "0x18450101320001");
  });
});

describe("personhood transactions on a single-pipeline runtime match 0.16.7", () => {
  // blake2-256 of the extrinsic, and the implication, that pad 0.16.7 builds
  // from the same inputs and metadata.
  test("claim_pgas", async () => {
    const { extrinsic, implication } = await claimOffline(claimPgas, loadMetadata("asset-hub-paseo-2005004"));
    assert.equal(hash(extrinsic), "0x709944be9b98fe67e538e29c9016f04478ff445499707ccbf5c0e1df721ab063");
    assert.equal(hex(implication), "0x912a1278cdb76f880793925d696982354db841309b7844f871930777f92b893c");
  });

  test("set_personal_id_account", async () => {
    const { extrinsic, implication } = await bindOffline(bindPersonalIdToAccount, loadMetadata("people-paseo-2005004"));
    assert.equal(hash(extrinsic), "0x2dfec5a47cb858805288f6798a20f722ca1366598ad93a55d70204d2ec8a3b16");
    assert.equal(hex(implication), "0xd08fe1d7ab2acd29d3e1956ad157b99047079f7942bb748f328e3a11b06ad623");
  });
});

describe("personhood transactions on versioned extension pipelines", () => {
  for (const { name } of RUNTIMES) {
    test(`${name}: claim_pgas decodes as a General transaction authorized by AsPgas`, async () => {
      const metadata = loadMetadata(`asset-hub-${name}`);
      const { extrinsic } = await claimOffline(claimPgas, metadata);
      const { version, call, active, consumedAll } = decodeGeneralExtrinsic(metadata, extrinsic);
      const expected = RUNTIMES.find((r) => r.name === name).version;
      assert.deepEqual({ version, call, active, consumedAll }, { version: expected, call: "Pgas.claim_pgas", active: ["AsPgas"], consumedAll: true });
    });

    test(`${name}: set_personal_id_account decodes as a General transaction authorized by AsPerson`, async () => {
      const metadata = loadMetadata(`people-${name}`);
      const { extrinsic } = await bindOffline(bindPersonalIdToAccount, metadata);
      const { version, call, active, consumedAll } = decodeGeneralExtrinsic(metadata, extrinsic);
      const expected = RUNTIMES.find((r) => r.name === name).version;
      assert.deepEqual(
        { version, call, active, consumedAll },
        { version: expected, call: "People.set_personal_id_account", active: ["AsPerson", "RestrictOrigins"], consumedAll: true },
      );
    });
  }

  for (const { name } of VERSIONED) {
    test(`${name}: the claim is the v0 claim plus the version and an inactive VerifyMultiSignature`, async () => {
      const v0 = body((await claimOffline(claimPgas, loadMetadata("asset-hub-paseo-2005004"))).extrinsic);
      const v1 = body((await claimOffline(claimPgas, loadMetadata(`asset-hub-${name}`))).extrinsic);
      // UnitTransactionExtension is empty, so VerifyMultiSignature is the first extension byte.
      assert.equal(hex(v1), hex(new Uint8Array([0x45, 0x01, 0x00, ...v0.subarray(2)])));
    });

    test(`${name}: the binding is the v0 binding with version 1`, async () => {
      const v0 = body((await bindOffline(bindPersonalIdToAccount, loadMetadata("people-paseo-2005004"))).extrinsic);
      const v1 = body((await bindOffline(bindPersonalIdToAccount, loadMetadata(`people-${name}`))).extrinsic);
      assert.equal(hex(v1), hex(new Uint8Array([0x45, 0x01, ...v0.subarray(2)])));
    });
  }
});
