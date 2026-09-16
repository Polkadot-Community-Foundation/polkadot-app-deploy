// VENDORED from @parity/product-sdk-auth — do not edit here; see src/auth/index.ts swap note.
// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ss58Encode } from "@parity/product-sdk-address";
import { deriveProductAccountPublicKey, seedToAccount } from "@parity/product-sdk-keys";
import type { UserSession } from "@parity/product-sdk-terminal";
import { createSessionSigner } from "./sessionSigner.js";

const DEV_PHRASE = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
// Injected product id (the consumer supplies this via ProductAccountRef). Uses
// the same value playground derives from so the product account is identical.
const PRODUCT_ID = "playground.dot";

/** Each test gets its own subtree-cache dir so nothing touches `~/.polkadot-apps`. */
function freshOptions() {
    return { appId: "sessionSigner-test", storageDir: mkdtempSync(join(tmpdir(), "pad-subtree-")) };
}

// ────────────────────────────────────────────────────────────────────────────
// RFC-0022 account equivalence.
//
// A product account lives at `//product//{productId}/{index}`. The first two
// junctions are HARD, so no public key above them can reach it — the subtree
// public key of `//product//{productId}` must come from the wallet, over the
// session, via `getProductSubtree`.
//
// These tests are the regression guard against the pre-RFC-0022 bug where the
// CLI soft-derived three junctions off `session.rootAccountId`, producing an
// address that matched no host and signed for the wrong account.
// ────────────────────────────────────────────────────────────────────────────
describe("session signer account equivalence (RFC-0022)", () => {
    /**
     * Stand-in for a paired wallet. `getProductSubtree` is what the real host
     * answers with: the public key of the hard-derived `//product//{productId}`
     * subtree. `rootAccountId` is present but must NOT be the derivation parent.
     */
    function fakeSession(mnemonic: string, calls?: string[]): UserSession {
        const root = seedToAccount(mnemonic, "");
        const wallet = seedToAccount(mnemonic, "//SomeWallet"); // user-picked account on mobile
        return {
            id: "test",
            localAccount: { accountId: new Uint8Array(32), pin: undefined },
            remoteAccount: {
                accountId: wallet.publicKey,
                publicKey: wallet.publicKey,
                pin: undefined,
            },
            rootAccountId: root.publicKey,
            getProductSubtree: async (productId: string) => {
                calls?.push(productId);
                return {
                    isErr: () => false,
                    value: seedToAccount(mnemonic, `//product//${productId}`).publicKey,
                };
            },
        } as unknown as UserSession;
    }

    /** The authoritative expectation: soft-derive the index off the subtree key. */
    function expectedProductAddress(mnemonic: string, productId: string, index: number): string {
        const subtree = seedToAccount(mnemonic, `//product//${productId}`).publicKey;
        return ss58Encode(deriveProductAccountPublicKey(subtree, { tag: "Index", value: index }));
    }

    test("signer address === subtree-derived product account", async () => {
        const session = fakeSession(DEV_PHRASE);

        const cliSigner = await createSessionSigner(
            session,
            { productId: PRODUCT_ID, derivationIndex: 0 },
            freshOptions(),
        );

        expect(ss58Encode(cliSigner.publicKey)).toEqual(
            expectedProductAddress(DEV_PHRASE, PRODUCT_ID, 0),
        );
    });

    test("the subtree key is fetched from the wallet, not computed locally", async () => {
        // The whole point of RFC-0022: the parent key crosses two hard junctions,
        // so it can only come from the Account Holder. If this stops being called,
        // the CLI is deriving from something it should not have been able to reach.
        const calls: string[] = [];
        const session = fakeSession(DEV_PHRASE, calls);

        await createSessionSigner(
            session,
            { productId: PRODUCT_ID, derivationIndex: 0 },
            freshOptions(),
        );

        expect(calls).toEqual([PRODUCT_ID]);
    });

    test("regression: signer does NOT derive from rootAccountId", async () => {
        // Pre-fix bug: the CLI soft-derived `/product/{id}/{index}` off
        // `session.rootAccountId`. Hard junctions make that unreachable, so the
        // resulting address matched no host and signed for the wrong account.
        const session = fakeSession(DEV_PHRASE);
        const cliSigner = await createSessionSigner(
            session,
            { productId: PRODUCT_ID, derivationIndex: 0 },
            freshOptions(),
        );
        const cliAddress = ss58Encode(cliSigner.publicKey);

        const oldSoftPath = ss58Encode(
            seedToAccount(DEV_PHRASE, `/product/${PRODUCT_ID}/0`).publicKey,
        );
        const rootAddress = ss58Encode(seedToAccount(DEV_PHRASE, "").publicKey);

        expect(cliAddress).not.toEqual(oldSoftPath);
        expect(cliAddress).not.toEqual(rootAddress);
    });

    test("regression: signer does NOT use remoteAccount.accountId (= wallet account)", async () => {
        const session = fakeSession(DEV_PHRASE);
        const cliSigner = await createSessionSigner(
            session,
            { productId: PRODUCT_ID, derivationIndex: 0 },
            freshOptions(),
        );
        const cliAddress = ss58Encode(cliSigner.publicKey);
        const walletAddress = ss58Encode(new Uint8Array(session.remoteAccount.accountId));

        // The wallet account is what the chain would see as From — different from
        // the funded / allowance-granted product account.
        expect(cliAddress).not.toEqual(walletAddress);
    });

    test("a different derivation index yields a different account", async () => {
        const session = fakeSession(DEV_PHRASE);
        const opts = freshOptions();

        const zero = await createSessionSigner(
            session,
            { productId: PRODUCT_ID, derivationIndex: 0 },
            opts,
        );
        const one = await createSessionSigner(
            session,
            { productId: PRODUCT_ID, derivationIndex: 1 },
            opts,
        );

        expect(ss58Encode(one.publicKey)).toEqual(expectedProductAddress(DEV_PHRASE, PRODUCT_ID, 1));
        expect(ss58Encode(one.publicKey)).not.toEqual(ss58Encode(zero.publicKey));
    });

    test("surfaces a wallet-side subtree failure", async () => {
        const session = {
            id: "test",
            rootAccountId: seedToAccount(DEV_PHRASE, "").publicKey,
            getProductSubtree: async () => ({
                isErr: () => true,
                error: { message: "user declined" },
            }),
        } as unknown as UserSession;

        await expect(
            createSessionSigner(
                session,
                { productId: PRODUCT_ID, derivationIndex: 0 },
                freshOptions(),
            ),
        ).rejects.toThrow(/user declined/);
    });
});

// ---------------------------------------------------------------------------
// Issue 2: console.error patch in sessionSigner swallows teardown noise
// ---------------------------------------------------------------------------
describe("sessionSigner teardown noise suppression (issue 2)", () => {
    test("console.error patch source contains teardown noise suppression for submitRequest failed", () => {
        // Verify the source-level fix is present — the patch now also swallows
        // "submitRequest failed: ... Not connected / DestroyedError / Client destroyed".
        const src = require("fs").readFileSync(
            require("path").join(__dirname, "sessionSigner.ts"),
            "utf8",
        );
        expect(src).toMatch(/submitRequest failed/i);
        expect(src).toMatch(/not connected|destroyederror|client destroyed/i);
    });
});
