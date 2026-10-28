/**
 * Pure-function tests for the identity and evidence prototype.
 *
 * These cover the parts that don't need an issuer key or a running chain:
 *   - DID document shape
 *   - stable JSON encoding (signature determinism)
 *   - CIDv1 raw construction
 *   - VC signature verification round-trip with a throwaway key
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";

import { didDocument, didForAddress, stableStringify, verifyCredential } from "./identity.js";
import { rawCidV1 } from "./evidence.js";

describe("DID document", () => {
  it("binds an eip155 account to a did:ethr identifier", () => {
    const address = "0x1111111111111111111111111111111111111111";
    const doc = didDocument(address, 31337);
    assert.equal(doc.id, `did:ethr:31337:${address}`);
    assert.equal(doc.verificationMethod[0].blockchainAccountId, `eip155:31337:${address}`);
    assert.deepEqual(doc.authentication, [`${doc.id}#controller`]);
  });

  it("is deterministic", () => {
    assert.deepEqual(didDocument("0xabc", 1), didDocument("0xabc", 1));
    assert.equal(didForAddress("0xabc", 1), "did:ethr:1:0xabc");
  });
});

describe("stableStringify", () => {
  it("produces the same bytes regardless of member order", () => {
    const a = { b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } };
    const b = { a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 };
    assert.equal(stableStringify(a), stableStringify(b));
  });

  it("preserves array order", () => {
    assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  });
});

describe("CIDv1 raw", () => {
  it("produces a version-1 raw CID in base32", () => {
    const cid = rawCidV1(Buffer.from("hello"));
    assert.match(cid, /^b[a-z2-7]{58,}$/);
  });

  it("is content-addressed, not filename-addressed", () => {
    assert.equal(rawCidV1(Buffer.from("same")), rawCidV1(Buffer.from("same")));
    assert.notEqual(rawCidV1(Buffer.from("same")), rawCidV1(Buffer.from("different")));
  });
});

describe("VC verification", async () => {
  const wallet = Wallet.createRandom();
  const now = new Date();
  const expiry = new Date(now.getTime() + 86_400_000);
  const unsigned = {
    "@context": ["https://www.w3.org/2018/credentials/v1"],
    id: "urn:uuid:test",
    type: ["VerifiableCredential", "VerifiedCreator"],
    issuer: didForAddress(wallet.address),
    issuanceDate: now.toISOString(),
    expirationDate: expiry.toISOString(),
    credentialSubject: { id: didForAddress("0x2222222222222222222222222222222222222222") },
  };
  const proofValue = await wallet.signMessage(stableStringify(unsigned));
  const credential = {
    ...unsigned,
    proof: {
      type: "EthereumPersonalSignature2021",
      created: now.toISOString(),
      verificationMethod: `${unsigned.issuer}#controller`,
      proofPurpose: "assertionMethod",
      proofValue,
    },
  };

  it("accepts a correctly signed, unexpired credential", async () => {
    const result = await verifyCredential(credential);
    assert.equal(result.valid, true);
    assert.equal(result.subject, "0x2222222222222222222222222222222222222222");
  });

  it("rejects a credential whose claims were altered after signing", async () => {
    const tampered = {
      ...credential,
      credentialSubject: { id: credential.credentialSubject.id, role: "admin" },
    };
    const result = await verifyCredential(tampered);
    assert.equal(result.valid, false);
  });

  it("rejects garbage", async () => {
    assert.equal((await verifyCredential({})).valid, false);
  });
});
