// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

// Solidity-style ABI fragments for the DotNS contracts on Asset Hub Next.
// Copied verbatim from dotdot-deployer — contract interfaces are stable across
// paseo-next v1 → v2, only the addresses changed.

export const REGISTRY_ABI = [
    {
        type: "function",
        name: "recordExists",
        inputs: [{ name: "node", type: "bytes32" }],
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "owner",
        inputs: [{ name: "node", type: "bytes32" }],
        outputs: [{ name: "", type: "address" }],
        stateMutability: "view",
    },
] as const;

export const REGISTRAR_CONTROLLER_ABI = [
    {
        type: "function",
        name: "makeCommitment",
        inputs: [
            {
                name: "registration",
                type: "tuple",
                components: [
                    { name: "label", type: "string" },
                    { name: "owner", type: "address" },
                    { name: "secret", type: "bytes32" },
                    { name: "reserved", type: "bool" },
                ],
            },
        ],
        outputs: [{ name: "commitment", type: "bytes32" }],
        stateMutability: "pure",
    },
    {
        type: "function",
        name: "commit",
        inputs: [{ name: "commitment", type: "bytes32" }],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "register",
        inputs: [
            {
                name: "registration",
                type: "tuple",
                components: [
                    { name: "label", type: "string" },
                    { name: "owner", type: "address" },
                    { name: "secret", type: "bytes32" },
                    { name: "reserved", type: "bool" },
                ],
            },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "minCommitmentAge",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
] as const;

export const CONTENT_RESOLVER_ABI = [
    {
        type: "function",
        name: "contenthash",
        inputs: [{ name: "node", type: "bytes32" }],
        outputs: [{ name: "hash", type: "bytes" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "setContenthash",
        inputs: [
            { name: "node", type: "bytes32" },
            { name: "hash", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;

export const POP_RULES_ABI = [
    {
        type: "function",
        name: "classifyName",
        inputs: [{ name: "name", type: "string" }],
        outputs: [
            { name: "requirement", type: "uint8" },
            { name: "message", type: "string" },
        ],
        stateMutability: "pure",
    },
    {
        type: "function",
        name: "price",
        inputs: [{ name: "name", type: "string" }],
        outputs: [{ name: "", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "priceWithoutCheck",
        inputs: [
            { name: "name", type: "string" },
            { name: "userAddress", type: "address" },
        ],
        outputs: [
            {
                name: "metadata",
                type: "tuple",
                components: [
                    { name: "price", type: "uint256" },
                    { name: "status", type: "uint8" },
                    { name: "userStatus", type: "uint8" },
                    { name: "message", type: "string" },
                ],
            },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "userPopStatus",
        inputs: [{ name: "", type: "address" }],
        outputs: [{ name: "", type: "uint8" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "setUserPopStatus",
        inputs: [{ name: "status", type: "uint8" }],
        outputs: [],
        stateMutability: "nonpayable",
    },
] as const;
