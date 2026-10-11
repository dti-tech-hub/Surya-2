// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CredentialRegistry
 * @notice On-chain record of Verifiable Credential hashes and their revocation status.
 *
 * @dev Privacy model (critical)
 *
 *      This contract stores **no personal data whatsoever**. It records only:
 *        - the keccak256 hash of a credential document,
 *        - a caller-chosen, non-identifying `credentialId` (e.g. a salted digest),
 *        - the schema/type string (e.g. "VerifiedCreator"),
 *        - an expiry timestamp and a revoked flag.
 *
 *      It never stores names, DOB, nationality, document numbers, or the credential
 *      body itself. The actual signed VC lives with the holder; this contract is a
 *      revocation registry and an attestation anchor so that a verifier can check
 *      "was this credential ever revoked?" on-chain without ever learning the holder's
 *      identity or the claims inside.
 *
 *      A revoked hash is recorded under a *revocation id* derived from the credential
 *      hash, so revoking does not reveal which holder it belonged to on-chain beyond
 *      the hash itself.
 *
 *      Trust assumption: the issuer (the backend's Veramo agent) is trusted to only
 *      attest credentials it has verified. The on-chain role exists so that the issuer
 *      key can be rotated without invalidating historic records.
 */
contract CredentialRegistry {
    /// @notice On-chain status of a credential hash.
    struct CredentialRecord {
        address issuer;
        bytes32 credentialHash;
        string schemaType; // e.g. "VerifiedCreator"
        uint64 issuedAt;
        uint64 expiresAt;
        bool revoked;
        uint64 revokedAt;
    }

    /* -------------------------------------------------------------------- */
    /*                                 Storage                               */
    /* -------------------------------------------------------------------- */

    address public admin;
    address public issuer;

    /// @notice credentialId => CredentialRecord. credentialId = keccak256(credentialHash).
    mapping(bytes32 => CredentialRecord) private credentials;

    /// @notice subject => whether they hold a currently-valid credential of a type.
    mapping(bytes32 => bool) public hasValidCredential;

    event AdminTransferred(address indexed from, address indexed to);
    event IssuerUpdated(address indexed from, address indexed to);
    event CredentialAttested(
        bytes32 indexed credentialId,
        address indexed holder,
        address indexed issuer,
        string schemaType,
        uint64 expiresAt
    );
    event CredentialRevoked(bytes32 indexed credentialId, address indexed issuer, uint64 revokedAt);

    error NotAdmin(address caller);
    error NotIssuer(address caller);
    error ZeroAddress();
    error InvalidExpiry(uint64 expiresAt, uint64 nowTs);
    error EmptySchema();
    error AlreadyAttested(bytes32 credentialId);
    error NotFound(bytes32 credentialId);
    error AlreadyRevoked(bytes32 credentialId);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin(msg.sender);
        _;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer(msg.sender);
        _;
    }

    constructor(address admin_, address issuer_) {
        if (admin_ == address(0) || issuer_ == address(0)) revert ZeroAddress();
        admin = admin_;
        issuer = issuer_;
    }

    /* -------------------------------------------------------------------- */
    /*                                Admin                                  */
    /* ------------------------------------------------------------------ */
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function setIssuer(address newIssuer) external onlyAdmin {
        if (newIssuer == address(0)) revert ZeroAddress();
        emit IssuerUpdated(issuer, newIssuer);
        issuer = newIssuer;
    }

    /* -------------------------------------------------------------------- */
    /*                            Attestation API                            */
    /* ------------------------------------------------------------------ */

    /**
     * @notice Records that the issuer vouched for a credential hash.
     * @param holder Subject the credential is bound to. Only the hash is stored.
     * @param credentialHash keccak256 digest of the signed VC.
     * @param schemaType Credential type, e.g. "VerifiedCreator" or "KycLite".
     * @param expiresAt Expiry timestamp; must be in the future.
     */
    function attestCredential(
        address holder,
        bytes32 credentialHash,
        string calldata schemaType,
        uint64 expiresAt
    ) external onlyIssuer {
        if (holder == address(0)) revert ZeroAddress();
        if (bytes(schemaType).length == 0) revert EmptySchema();
        if (expiresAt <= block.timestamp) revert InvalidExpiry(expiresAt, uint64(block.timestamp));

        bytes32 credentialId = keccak256(abi.encodePacked(credentialHash, holder));
        if (credentials[credentialId].issuedAt != 0) revert AlreadyAttested(credentialId);

        credentials[credentialId] = CredentialRecord({
            issuer: msg.sender,
            credentialHash: credentialHash,
            schemaType: schemaType,
            issuedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            revoked: false,
            revokedAt: 0
        });

        emit CredentialAttested(credentialId, holder, msg.sender, schemaType, expiresAt);
    }

    /// @notice Revokes an attested credential hash.
    function revokeCredential(bytes32 credentialHash, address holder) external onlyIssuer {
        bytes32 credentialId = keccak256(abi.encodePacked(credentialHash, holder));
        CredentialRecord storage c = credentials[credentialId];
        if (c.issuedAt == 0) revert NotFound(credentialId);
        if (c.revoked) revert AlreadyRevoked(credentialId);

        c.revoked = true;
        c.revokedAt = uint64(block.timestamp);

        emit CredentialRevoked(credentialId, msg.sender, uint64(block.timestamp));
    }

    /* -------------------------------------------------------------------- */
    /*                                 Views                                */
    /* ------------------------------------------------------------------ */

    /// @notice Reads the full record for a credential id.
    function getCredential(bytes32 credentialId) external view returns (CredentialRecord memory) {
        return credentials[credentialId];
    }

    /**
     * @notice Whether a holder currently holds a valid, unrevoked credential of `schemaType`.
     * @dev Used by the frontend and by off-chain verification. Does not leak any claims
     *      beyond the fact that *a* credential of this type is valid.
     */
    function isCredentialValid(address holder, bytes32 credentialHash, string calldata schemaType)
        external
        view
        returns (bool)
    {
        bytes32 credentialId = keccak256(abi.encodePacked(credentialHash, holder));
        CredentialRecord storage c = credentials[credentialId];
        return (c.issuedAt != 0) && (!c.revoked) && (c.expiresAt > block.timestamp) && keccak256(bytes(c.schemaType)) == keccak256(bytes(schemaType));
    }
}