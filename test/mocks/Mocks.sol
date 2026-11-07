// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.26;

/// Minimal ERC-20 for tests.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        _spend(from, amount);
        _move(from, to, amount);
        return true;
    }

    function _spend(address from, uint256 amount) internal {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
    }

    function _move(address from, address to, uint256 amount) internal {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// Policy registry with the B20 built-ins: 0 always allows, 1 always blocks; other ids are allowlists.
contract MockPolicyRegistry {
    mapping(uint64 => bool) public created;
    mapping(uint64 => mapping(address => bool)) public allowed;

    function create(uint64 id) external {
        created[id] = true;
    }

    function setAllowed(uint64 id, address a, bool ok) external {
        allowed[id][a] = ok;
    }

    function policyExists(uint64 id) external view returns (bool) {
        return id <= 1 || created[id];
    }

    function isAuthorized(uint64 id, address a) public view returns (bool) {
        if (id == 0) return true;
        if (id == 1) return false;
        return created[id] && allowed[id][a];
    }
}

/// The parts of a B20 Asset that Summon reads, with B20's transfer rules: TRANSFER pause, and the sender,
/// receiver and executor policies checked on every transfer.
contract MockB20 is MockERC20 {
    bytes32 public constant TRANSFER_SENDER_POLICY = keccak256("TRANSFER_SENDER_POLICY");
    bytes32 public constant TRANSFER_RECEIVER_POLICY = keccak256("TRANSFER_RECEIVER_POLICY");
    bytes32 public constant TRANSFER_EXECUTOR_POLICY = keccak256("TRANSFER_EXECUTOR_POLICY");

    MockPolicyRegistry public immutable registry;
    uint256 public multiplier = 1e18;
    uint256 public effectiveAt;
    bool public transferPaused;
    bool public pauseReadReverts;
    mapping(bytes32 => uint64) internal _policy;

    error ContractPaused(uint8 feature);
    error PolicyForbids(bytes32 scope, address account);

    constructor(MockPolicyRegistry r) MockERC20("Demo GME", "dGMEc", 8) {
        registry = r;
    }

    function setMultiplier(uint256 m) external {
        multiplier = m;
    }

    function setEffectiveAt(uint256 t) external {
        effectiveAt = t;
    }

    function setTransferPaused(bool p) external {
        transferPaused = p;
    }

    function setPauseReadReverts(bool r) external {
        pauseReadReverts = r;
    }

    function setPolicy(bytes32 scope, uint64 id) external {
        _policy[scope] = id;
    }

    function policyId(bytes32 scope) external view returns (uint64) {
        return _policy[scope];
    }

    function isPaused(uint8 feature) external view returns (bool) {
        require(!pauseReadReverts, "unreadable");
        return feature == 0 && transferPaused;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _check(msg.sender, to);
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        _check(from, to);
        _spend(from, amount);
        _move(from, to, amount);
        return true;
    }

    function _check(address from, address to) internal view {
        if (transferPaused) revert ContractPaused(0);
        if (!registry.isAuthorized(_policy[TRANSFER_SENDER_POLICY], from)) revert PolicyForbids(TRANSFER_SENDER_POLICY, from);
        if (!registry.isAuthorized(_policy[TRANSFER_RECEIVER_POLICY], to)) revert PolicyForbids(TRANSFER_RECEIVER_POLICY, to);
        if (msg.sender != from && !registry.isAuthorized(_policy[TRANSFER_EXECUTOR_POLICY], msg.sender)) {
            revert PolicyForbids(TRANSFER_EXECUTOR_POLICY, msg.sender);
        }
    }
}

/// Coinbase's oracle registry shape (getOracleParams, selector 0xd4197e82).
contract MockOracleRegistry {
    uint256 public m = 1e18;
    bool public paused;

    function set(uint256 m_, bool paused_) external {
        m = m_;
        paused = paused_;
    }

    function getOracleParams(address) external view returns (uint256, bool) {
        return (m, paused);
    }
}
