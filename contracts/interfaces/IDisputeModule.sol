// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal interface the campaign factory uses to register a newly deployed
///         campaign with the dispute module. Keeping it narrow avoids a circular
///         dependency between {CampaignFactory} and {DisputeResolution}.
interface IDisputeModule {
    function registerCampaign(address campaign) external;
}
