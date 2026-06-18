#!/usr/bin/env bash
# Install the cargo-pvm-contract CLI at the rev matching this repo's pinned
# `pvm_contract` dependency.
#
# Why this exists: CDM's install.sh installs cargo-pvm-contract from `main` —
# the new pvm-contract-sdk lineage, which generates the ABI by host-compiling
# the contract (`--features abi-gen`). This repo's contract is still on the
# older `pvm_contract` crate (cargo-pvm-contract branch `charles/cdm-integration`);
# its OrderedIndex hasn't been ported to the new SDK yet, and its ABI is
# extracted from the compiled ELF rather than a host build. The main-branch CLI
# therefore fails (`no global memory allocator` / `common` host-compile errors).
# Reinstall the matching CLI so `cdm build` / `cdm deploy` use the ELF-extract
# ABI path.
#
# The rev is read from Cargo.lock so it stays in lock-step with the dependency
# automatically — no hardcoded SHA to keep in sync. Run this before `cdm build`
# (CI does so in .github/workflows/deploy-contracts.yml; local devs should too
# whenever CDM's installer has overwritten the CLI).
set -euo pipefail

REV=$(grep -oE 'cargo-pvm-contract\?branch=[^#]*#[0-9a-f]{40}' Cargo.lock \
  | head -1 | grep -oE '[0-9a-f]{40}$' || true)

if [ -z "${REV:-}" ]; then
  echo "Error: could not find a cargo-pvm-contract rev in Cargo.lock" >&2
  exit 1
fi

echo "Installing cargo-pvm-contract at rev ${REV} (derived from Cargo.lock)..."
cargo install --git https://github.com/paritytech/cargo-pvm-contract \
  --rev "${REV}" --force cargo-pvm-contract
cargo pvm-contract --help | head -1
