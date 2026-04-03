// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title DAARegistry — On-Chain Document Registry
/// @notice Append-only registry of ratified documents organized by category with a document
///         layer (categories as folders containing independent documents), external references,
///         per-document amendment restrictions, and two-tier governance authority.
contract DAARegistry {
    // ──────────────────────── Structs ──────────────────────────

    struct Document {
        string arweaveTxId;
        bytes32 contentHash;
        string title;
        uint256 version;
        uint256 timestamp;
        string voteId;
        uint8 docType;
    }

    struct DocumentInput {
        uint256 categoryId;
        uint256 documentId;
        string arweaveTxId;
        bytes32 contentHash;
        string title;
        string voteId;
        uint8 docType;
    }

    struct ExternalReference {
        address registryAddress;
        uint256 chainId;
        uint256 categoryId;
        uint256 documentId;
        uint256 version;
        uint8 relationType;
        string targetSection;
    }

    struct AmendmentRestrictions {
        uint256 minTimeBetweenAmendments;
        uint256 lastAmendmentTime;
        uint256[] lockedSections;
    }

    // ──────────────────────── State ───────────────────────────

    address public normalAuthority;
    address public coreAuthority;
    mapping(uint256 => string) public categoryNames;
    uint256 public categoryCount;
    mapping(uint256 => uint256) private _documentCounts;
    mapping(uint256 => mapping(uint256 => uint256)) private _versionCounts;
    mapping(uint256 => mapping(uint256 => mapping(uint256 => Document))) private _documents;
    mapping(uint256 => mapping(uint256 => mapping(uint256 => ExternalReference[]))) private _references;
    mapping(uint256 => mapping(uint256 => AmendmentRestrictions)) private _amendmentRestrictions;

    // ──────────────────────── Events ──────────────────────────

    event CategoryAdded(uint256 indexed categoryId, string name);
    event DocumentAdded(
        uint256 indexed categoryId,
        uint256 indexed documentId,
        uint256 indexed version,
        string arweaveTxId,
        bytes32 contentHash,
        uint8 docType
    );
    event NormalAuthorityTransferred(address indexed previous, address indexed current);
    event CoreAuthorityTransferred(address indexed previous, address indexed current);
    event AmendmentRestrictionsUpdated(uint256 indexed categoryId, uint256 indexed documentId);

    // ──────────────────────── Errors ──────────────────────────

    error NotAuthority();
    error NotCoreAuthority();
    error CategoryDoesNotExist(uint256 categoryId);
    error DocumentDoesNotExist(uint256 categoryId, uint256 documentId);
    error VersionDoesNotExist(uint256 categoryId, uint256 documentId, uint256 version);
    error InvalidAuthority();

    // ──────────────────────── Modifiers ──────────────────────

    modifier onlyAuthority() {
        if (msg.sender != normalAuthority && msg.sender != coreAuthority) {
            revert NotAuthority();
        }
        _;
    }

    modifier onlyCoreAuthority() {
        if (msg.sender != coreAuthority) {
            revert NotCoreAuthority();
        }
        _;
    }

    // ──────────────────────── Constructor ─────────────────────

    constructor(address _coreAuthority) {
        if (_coreAuthority == address(0)) {
            revert InvalidAuthority();
        }
        coreAuthority = _coreAuthority;
        emit CoreAuthorityTransferred(address(0), _coreAuthority);
    }

    // ──────────────────────── Public / External ──────────────

    /// @notice Create a new document category.
    /// @param name Human-readable category name.
    /// @return categoryId The sequential ID assigned to the new category.
    function addCategory(string calldata name) external onlyCoreAuthority returns (uint256) {
        uint256 categoryId = categoryCount++;
        categoryNames[categoryId] = name;

        emit CategoryAdded(categoryId, name);
        return categoryId;
    }

    /// @notice Record a ratified document on-chain. Append-only.
    /// @param input Document metadata. documentId = 0 creates a new document, > 0 amends existing.
    /// @param refs Array of external references (can be empty).
    /// @return documentId The document ID (new or existing).
    /// @return version The auto-incremented version number assigned.
    function addDocument(DocumentInput calldata input, ExternalReference[] calldata refs)
        external
        onlyAuthority
        returns (uint256 documentId, uint256 version)
    {
        if (input.categoryId >= categoryCount) {
            revert CategoryDoesNotExist(input.categoryId);
        }

        if (input.documentId == 0) {
            documentId = ++_documentCounts[input.categoryId];
        } else {
            if (input.documentId > _documentCounts[input.categoryId]) {
                revert DocumentDoesNotExist(input.categoryId, input.documentId);
            }
            documentId = input.documentId;
        }

        version = ++_versionCounts[input.categoryId][documentId];

        _documents[input.categoryId][documentId][version] = Document({
            arweaveTxId: input.arweaveTxId,
            contentHash: input.contentHash,
            title: input.title,
            version: version,
            timestamp: block.timestamp,
            voteId: input.voteId,
            docType: input.docType
        });

        for (uint256 i = 0; i < refs.length; i++) {
            _references[input.categoryId][documentId][version].push(refs[i]);
        }

        _amendmentRestrictions[input.categoryId][documentId].lastAmendmentTime = block.timestamp;

        emit DocumentAdded(input.categoryId, documentId, version, input.arweaveTxId, input.contentHash, input.docType);
    }

    // ──────────────────────── Read Functions ──────────────────

    /// @notice Retrieve a specific document version.
    function getDocument(uint256 categoryId, uint256 documentId, uint256 version)
        external
        view
        returns (Document memory)
    {
        _requireCategory(categoryId);
        _requireDocument(categoryId, documentId);
        if (version == 0 || version > _versionCounts[categoryId][documentId]) {
            revert VersionDoesNotExist(categoryId, documentId, version);
        }
        return _documents[categoryId][documentId][version];
    }

    /// @notice Retrieve the most recent version of a document.
    function getLatest(uint256 categoryId, uint256 documentId) external view returns (Document memory) {
        _requireCategory(categoryId);
        _requireDocument(categoryId, documentId);
        uint256 latest = _versionCounts[categoryId][documentId];
        if (latest == 0) {
            revert VersionDoesNotExist(categoryId, documentId, 0);
        }
        return _documents[categoryId][documentId][latest];
    }

    /// @notice Retrieve all versions of a document.
    function getHistory(uint256 categoryId, uint256 documentId) external view returns (Document[] memory) {
        _requireCategory(categoryId);
        _requireDocument(categoryId, documentId);
        uint256 count = _versionCounts[categoryId][documentId];
        Document[] memory docs = new Document[](count);
        for (uint256 i = 0; i < count; i++) {
            docs[i] = _documents[categoryId][documentId][i + 1];
        }
        return docs;
    }

    /// @notice Retrieve external references for a document version.
    function getReferences(uint256 categoryId, uint256 documentId, uint256 version)
        external
        view
        returns (ExternalReference[] memory)
    {
        _requireCategory(categoryId);
        _requireDocument(categoryId, documentId);
        if (version == 0 || version > _versionCounts[categoryId][documentId]) {
            revert VersionDoesNotExist(categoryId, documentId, version);
        }
        return _references[categoryId][documentId][version];
    }

    /// @notice Retrieve the version count for a document.
    function getVersionCount(uint256 categoryId, uint256 documentId) external view returns (uint256) {
        _requireCategory(categoryId);
        _requireDocument(categoryId, documentId);
        return _versionCounts[categoryId][documentId];
    }

    /// @notice Retrieve the document count for a category.
    function getDocumentCount(uint256 categoryId) external view returns (uint256) {
        _requireCategory(categoryId);
        return _documentCounts[categoryId];
    }

    /// @notice Retrieve amendment restrictions for a document.
    function getAmendmentRestrictions(uint256 categoryId, uint256 documentId)
        external
        view
        returns (uint256 minTimeBetweenAmendments, uint256 lastAmendmentTime, uint256[] memory lockedSections)
    {
        _requireCategory(categoryId);
        _requireDocument(categoryId, documentId);
        AmendmentRestrictions storage r = _amendmentRestrictions[categoryId][documentId];
        return (r.minTimeBetweenAmendments, r.lastAmendmentTime, r.lockedSections);
    }

    // ──────────────────────── Governance ──────────────────────

    /// @notice Set the normal authority address (routine governance).
    /// @param newAuthority The new normal authority (cannot be address(0)).
    function setNormalAuthority(address newAuthority) external onlyCoreAuthority {
        if (newAuthority == address(0)) {
            revert InvalidAuthority();
        }
        address previous = normalAuthority;
        normalAuthority = newAuthority;
        emit NormalAuthorityTransferred(previous, newAuthority);
    }

    /// @notice Set the core authority address (structural governance).
    /// @param newAuthority The new core authority (cannot be address(0)).
    function setCoreAuthority(address newAuthority) external onlyCoreAuthority {
        if (newAuthority == address(0)) {
            revert InvalidAuthority();
        }
        address previous = coreAuthority;
        coreAuthority = newAuthority;
        emit CoreAuthorityTransferred(previous, newAuthority);
    }

    /// @notice Configure amendment restrictions for a document.
    function setAmendmentRestrictions(
        uint256 categoryId,
        uint256 documentId,
        uint256 minTimeBetweenAmendments,
        uint256[] calldata lockedSections
    ) external onlyCoreAuthority {
        _requireCategory(categoryId);
        _requireDocument(categoryId, documentId);
        AmendmentRestrictions storage r = _amendmentRestrictions[categoryId][documentId];
        r.minTimeBetweenAmendments = minTimeBetweenAmendments;
        r.lockedSections = lockedSections;

        emit AmendmentRestrictionsUpdated(categoryId, documentId);
    }

    // ──────────────────────── Internal ────────────────────────

    function _requireCategory(uint256 categoryId) internal view {
        if (categoryId >= categoryCount) {
            revert CategoryDoesNotExist(categoryId);
        }
    }

    function _requireDocument(uint256 categoryId, uint256 documentId) internal view {
        if (documentId == 0 || documentId > _documentCounts[categoryId]) {
            revert DocumentDoesNotExist(categoryId, documentId);
        }
    }
}
