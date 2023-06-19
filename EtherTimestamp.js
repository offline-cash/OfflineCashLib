require("@ethersproject/shims");
const { ethers } = require("ethers");
let module_util = require("./Util.js");
let hexToBytes = module_util.hexToBytes;

async function getEtherscanProvider(apiToken) {
    return new ethers.providers.EtherscanProvider(
        'homestead',
        apiToken,
    );
}

async function getJsonRpcProvider(url) {
    return new ethers.providers.JsonRpcProvider({"url": url, "timeout": 2000});
}

async function getEtherLatestBlock(provider) {
    const block = await provider.getBlock();

    return {
        number: block.number,
        hashStr: block.hash,
        hashBin: hexToBytes(block.hash.replace('0x', '')),
        timestamp: block.timestamp,
    };
}

async function getEtherHashByHeight(provider, height) {
    const block = await provider.getBlock(height);

    return {
        hashStr: block.hash,
        hashBin: hexToBytes(block.hash.replace('0x', '')),
        timestamp: block.timestamp,
    };
}

module.exports = {
    getEtherscanProvider,
    getJsonRpcProvider,
    getEtherLatestBlock,
    getEtherHashByHeight
};
