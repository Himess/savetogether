#!/usr/bin/env bash
# Verifies every deployed contract on Etherscan, with the constructor arguments
# read from out/deployment.json so they cannot drift from what was deployed.
#
# Needs ETHERSCAN_API_KEY in hardhat vars:  npx hardhat vars set ETHERSCAN_API_KEY
set -e
cd "$(dirname "$0")/.."
POOL=$(node -p "require('./out/deployment.json').pool")
SRC=$(node -p "require('./out/deployment.json').yieldSource")
TOKEN=$(node -p "require('./out/deployment.json').token")
BATCHER=$(node -p "require('./out/deployment.json').depositBatcher")
RATE=$(node -p "require('./out/deployment.json').rateBps")
PERIOD=$(node -p "require('./out/deployment.json').minPeriod")
MODULE=$(node -p "require('./out/deployment.json').module")

npx hardhat verify --network sepolia "$POOL" "$TOKEN" "$PERIOD"
npx hardhat verify --network sepolia "$SRC" "$TOKEN" "$BATCHER" "$RATE" "$POOL"
npx hardhat verify --network sepolia "$MODULE"
