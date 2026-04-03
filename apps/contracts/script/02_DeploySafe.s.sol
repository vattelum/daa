// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

interface ISafe {
    function setup(
        address[] calldata _owners,
        uint256 _threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
}

/// @notice Step 2: Deploy a Gnosis Safe with the deployer as sole owner.
/// After deployment, set SAFE_ADDRESS in .env before running step 3.
contract DeploySafe is Script {
    // Safe v1.3.0 on Sepolia
    address constant SAFE_SINGLETON = 0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552;
    address constant SAFE_PROXY_FACTORY = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;
    address constant SAFE_FALLBACK_HANDLER = 0x017062a1dE2FE6b99BE3d9d37841FeD19F573804;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deployer:", deployer);

        address[] memory owners = new address[](1);
        owners[0] = deployer;

        bytes memory safeInitializer = abi.encodeWithSelector(
            ISafe.setup.selector,
            owners,
            uint256(1),
            address(0),
            bytes(""),
            SAFE_FALLBACK_HANDLER,
            address(0),
            uint256(0),
            address(0)
        );

        vm.startBroadcast(deployerPrivateKey);

        address safe = ISafeProxyFactory(SAFE_PROXY_FACTORY).createProxyWithNonce(
            SAFE_SINGLETON, safeInitializer, block.timestamp
        );
        console.log("Gnosis Safe deployed at:", safe);

        vm.stopBroadcast();
    }
}
