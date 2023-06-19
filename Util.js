const {Buffer} = require("buffer");

function jsonParseWithBuffers(inputText) {
    return JSON.parse(inputText, (k, v) => {
        if (
            v !== null &&
            typeof v === 'object' &&
            'type' in v &&
            v.type === 'Buffer' &&
            'data' in v &&
            Array.isArray(v.data)
        ) {
            return Buffer.from(v.data);
        }
        return v;
    });
}

function hexToBytes(hex) {
    let bytes, c;
    for (bytes = [], c = 0; c < hex.length; c += 2) {
        bytes.push(parseInt(hex.substr(c, 2), 16));
    }
    return bytes;
}

function bytesToHex(bytes) {
    let hex, i;
    for (hex = [], i = 0; i < bytes.length; i++) {
        let current = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
        // eslint-disable-next-line no-bitwise
        hex.push((current >>> 4).toString(16));
        hex.push((current & 0xf).toString(16));
    }
    return hex.join('');
}

function arrayCompare(a1, a2) {
    return a1.length === a2.length && a1.every((v, i) => v === a2[i]);
}

module.exports = {
    jsonParseWithBuffers,
    hexToBytes,
    bytesToHex,
    arrayCompare,
};
