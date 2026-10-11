import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { ethers } from "hardhat";
import { expect } from "chai";

/**
 * Identity layer tests.
 *
 * The central assertion of this suite is a *negative* one: the contract must never
 * store PII. Since a hash cannot be inverted, the strongest practical check available
 * is that attestation only accepts a hash and a non-identifying schema string, and
 * that the recorded state contains no free-form personal data.
 */
async function fixture() {
  const [admin, issuer, holder, other] = await ethers.getSigners();
  const Registry = await ethers.getContractFactory("CredentialRegistry");
  const registry = await Registry.deploy(admin.address, issuer.address);
  await registry.waitForDeployment();
  return { registry, admin, issuer, holder, other };
}

describe("CredentialRegistry", () => {
  describe("access control", () => {
    it("rejects attestation from a non-issuer", async () => {
      const { registry, holder } = await loadFixture(fixture);
      await expect(
        registry
          .connect(holder)
          .attestCredential(
            holder.address,
            ethers.keccak256(ethers.toUtf8Bytes("vc")),
            "VerifiedCreator",
            (await time.latest()) + 86400
          )
      ).to.be.revertedWithCustomError(registry, "NotIssuer");
    });

    it("rejects revocation from a non-issuer", async () => {
      const { registry, issuer, holder } = await loadFixture(fixture);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("vc"));
      const expiry = (await time.latest()) + 86400;
      await registry
        .connect(issuer)
        .attestCredential(holder.address, hash, "VerifiedCreator", expiry);

      await expect(
        registry.connect(holder).revokeCredential(hash, holder.address)
      ).to.be.revertedWithCustomError(registry, "NotIssuer");
    });

    it("rejects issuer rotation from a non-admin", async () => {
      const { registry, holder } = await loadFixture(fixture);
      await expect(
        registry.connect(holder).setIssuer(holder.address)
      ).to.be.revertedWithCustomError(registry, "NotAdmin");
    });
  });

  describe("attestation", () => {
    it("records a credential hash and reports it valid", async () => {
      const { registry, issuer, holder } = await loadFixture(fixture);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("vc-1"));
      const expiry = (await time.latest()) + 86400;

      await registry
        .connect(issuer)
        .attestCredential(holder.address, hash, "VerifiedCreator", expiry);

      const credentialId = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "address"], [hash, holder.address])
      );
      const record = await registry.getCredential(credentialId);

      expect(record.issuer).to.equal(issuer.address);
      expect(record.credentialHash).to.equal(hash);
      expect(record.schemaType).to.equal("VerifiedCreator");
      expect(record.revoked).to.equal(false);
      expect(
        await registry.isCredentialValid(holder.address, hash, "VerifiedCreator")
      ).to.equal(true);
    });

    it("rejects a past expiry", async () => {
      const { registry, issuer, holder } = await loadFixture(fixture);
      const past = (await time.latest()) - 100;
      await expect(
        registry
          .connect(issuer)
          .attestCredential(
            holder.address,
            ethers.keccak256(ethers.toUtf8Bytes("vc")),
            "VerifiedCreator",
            past
          )
      ).to.be.revertedWithCustomError(registry, "InvalidExpiry");
    });

    it("rejects an empty schema type", async () => {
      const { registry, issuer, holder } = await loadFixture(fixture);
      await expect(
        registry
          .connect(issuer)
          .attestCredential(
            holder.address,
            ethers.keccak256(ethers.toUtf8Bytes("vc")),
            "",
            (await time.latest()) + 86400
          )
      ).to.be.revertedWithCustomError(registry, "EmptySchema");
    });

    it("rejects a duplicate attestation for the same hash+holder", async () => {
      const { registry, issuer, holder } = await loadFixture(fixture);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("vc"));
      const expiry = (await time.latest()) + 86400;
      await registry.connect(issuer).attestCredential(holder.address, hash, "VerifiedCreator", expiry);

      await expect(
        registry.connect(issuer).attestCredential(holder.address, hash, "VerifiedCreator", expiry)
      ).to.be.revertedWithCustomError(registry, "AlreadyAttested");
    });

    it("treats the same hash for a different holder as distinct", async () => {
      const { registry, issuer, holder, other } = await loadFixture(fixture);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("shared"));
      const expiry = (await time.latest()) + 86400;

      await registry.connect(issuer).attestCredential(holder.address, hash, "KycLite", expiry);
      // Same document hash, different subject: must not collide.
      await registry.connect(issuer).attestCredential(other.address, hash, "KycLite", expiry);

      expect(
        await registry.isCredentialValid(holder.address, hash, "KycLite")
      ).to.equal(true);
      expect(await registry.isCredentialValid(other.address, hash, "KycLite")).to.equal(true);
    });
  });

  describe("revocation", () => {
    it("invalidates a revoked credential", async () => {
      const { registry, issuer, holder } = await loadFixture(fixture);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("vc"));
      const expiry = (await time.latest()) + 86400;

      await registry.connect(issuer).attestCredential(holder.address, hash, "VerifiedCreator", expiry);
      expect(
        await registry.isCredentialValid(holder.address, hash, "VerifiedCreator")
      ).to.equal(true);

      await registry.connect(issuer).revokeCredential(hash, holder.address);
      expect(
        await registry.isCredentialValid(holder.address, hash, "VerifiedCreator")
      ).to.equal(false);
    });

    it("rejects revoking an unknown credential", async () => {
      const { registry, issuer, holder } = await loadFixture(fixture);
      await expect(
        registry
          .connect(issuer)
          .revokeCredential(ethers.keccak256(ethers.toUtf8Bytes("nope")), holder.address)
      ).to.be.revertedWithCustomError(registry, "NotFound");
    });

    it("rejects double revocation", async () => {
      const { registry, issuer, holder } = await loadFixture(fixture);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("vc"));
      await registry
        .connect(issuer)
        .attestCredential(holder.address, hash, "VerifiedCreator", (await time.latest()) + 86400);

      await registry.connect(issuer).revokeCredential(hash, holder.address);
      await expect(
        registry.connect(issuer).revokeCredential(hash, holder.address)
      ).to.be.revertedWithCustomError(registry, "AlreadyRevoked");
    });
  });

  describe("privacy property", () => {
    it("stores only a hash, never a name or document identifier", async () => {
      const { registry, issuer, holder } = await loadFixture(fixture);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("vc"));
      const expiry = (await time.latest()) + 86400;
      await registry.connect(issuer).attestCredential(holder.address, hash, "VerifiedCreator", expiry);

      const credentialId = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "address"], [hash, holder.address])
      );
      const record = await registry.getCredential(credentialId);

      // The stored digest must be exactly the 32-byte hash that was supplied; there is
      // no string field on the record that could hold personal data.
      expect(record.credentialHash).to.equal(hash);

      // The only free-form string the registry can hold is the schema *type*. Every
      // other field is an address, a 32-byte hash, or a numeric timestamp, so there is
      // no field capable of storing a name, DOB, or document number.
      expect(typeof record.schemaType).to.equal("string");
      expect(record.schemaType).to.equal("VerifiedCreator");
      expect(typeof record.issuer).to.equal("string");
      expect(ethers.isAddress(record.issuer)).to.equal(true);
      expect(record.credentialHash).to.match(/^0x[0-9a-f]{64}$/);
      expect(typeof record.issuedAt).to.equal("bigint");
      expect(typeof record.expiresAt).to.equal("bigint");
      expect(typeof record.revoked).to.equal("boolean");
    });

    it("does not report a credential as valid for a different schema type", async () => {
      const { registry, issuer, holder } = await loadFixture(fixture);
      const hash = ethers.keccak256(ethers.toUtf8Bytes("vc"));
      await registry
        .connect(issuer)
        .attestCredential(holder.address, hash, "VerifiedCreator", (await time.latest()) + 86400);

      // A holder must not be able to repurpose a creator credential as a KYC one.
      expect(await registry.isCredentialValid(holder.address, hash, "KycLite")).to.equal(false);
    });
  });
});

describe("MockOracleAdapter", () => {
  it("returns the configured verdict and exposes its source description", async () => {
    const Mock = await ethers.getContractFactory("MockOracleAdapter");
    const oracle = await Mock.deploy(true, "unit-test source");
    await oracle.waitForDeployment();

    expect(
      await oracle.attest(ethers.ZeroAddress, 0, ethers.ZeroHash)
    ).to.equal(true);
    expect(await oracle.sourceDescription()).to.equal("unit-test source");
  });

  it("allows the configured verdict to be flipped", async () => {
    const Mock = await ethers.getContractFactory("MockOracleAdapter");
    const oracle = await Mock.deploy(false, "unit-test source");
    await oracle.waitForDeployment();

    expect(await oracle.attest(ethers.ZeroAddress, 0, ethers.ZeroHash)).to.equal(false);
    await oracle.setVerdict(true);
    expect(await oracle.attest(ethers.ZeroAddress, 0, ethers.ZeroHash)).to.equal(true);
  });
});