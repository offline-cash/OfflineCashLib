let module_buffer = require("buffer");
let Buffer = module_buffer.Buffer;

let bitcoin = require("bitcoinjs-lib");
let ECPair = bitcoin.ECPair;
let axios = require("axios");

const MAX_FEE_PER_VB = 500;


function csvCheckSigOutput(clientKeyPair, serverKeyPair, lockTimeTs) {
    return bitcoin.script.fromASM(
        `
      OP_IF
          ${bitcoin.script.number.encode(lockTimeTs).toString('hex')}
          OP_CHECKLOCKTIMEVERIFY
          OP_DROP
      OP_ELSE
          ${serverKeyPair.publicKey.toString('hex')}
          OP_CHECKSIGVERIFY
      OP_ENDIF
      ${clientKeyPair.publicKey.toString('hex')}
      OP_CHECKSIG
    `
            .trim()
            .replace(/\s+/g, ' '),
    );
}

function privKeyToPublic(privKey) {
    return ECPair.fromPrivateKey(privKey).publicKey;
}

function getMultisigPayment(network, serverPubKey, clientPubKey, lockTimeTs) {
    const impClientKey = ECPair.fromPublicKey(clientPubKey);
    const impServerKey = ECPair.fromPublicKey(serverPubKey);

    return bitcoin.payments.p2sh({
        redeem: {output: csvCheckSigOutput(impClientKey, impServerKey, lockTimeTs)},
        network: network,
    });
}

async function getRecommendedFee(esploraAPI) {
    let res = await axios.get(esploraAPI + '/fee-estimates?_=' + Math.random());

    let feePerVbRapid = res.data['1'] * 1.1;
    let feePerVbFast = res.data['6'] * 1.1;
    let feePerVbEconomic = res.data['144'] * 1.1;

    if (feePerVbRapid > MAX_FEE_PER_VB || feePerVbFast > MAX_FEE_PER_VB || feePerVbEconomic > MAX_FEE_PER_VB) {
        throw new Error(
            'Exceeded sanity limit of ' + MAX_FEE_PER_VB + ' sats per byte.',
        );
    }

    return {
        rapid: feePerVbRapid,
        fast: feePerVbFast,
        economic: feePerVbEconomic
    };
}

async function checkAddressBalance(esploraAPI, address) {
    return await new Promise((resolve, reject) => {
        axios
            .get(esploraAPI + '/address/' + address)
            .then(res => {
                resolve(
                    res.data.chain_stats.funded_txo_sum -
                    res.data.chain_stats.spent_txo_sum,
                );
            })
            .catch(error => {
                reject(error);
            });
    });
}

async function analyseTransfersOnAddress(esploraAPI, address) {
    let out = [];
    let res = await axios.get(esploraAPI + '/address/' + address + '/txs');

    res.data.forEach((tx) => {
        let sum = 0;
        let hasAny = false;

        tx.vout.forEach((txout) => {
            if (txout.scriptpubkey_address === address) {
                sum += txout.value;
                hasAny = true;
            }
        });

        if (hasAny) {
            out.push({
                "type": "in",
                "txid": tx.txid,
                "value": sum,
                "confirmed": tx.status.confirmed,
                "time": tx.status.block_time,
            });
        }
    });

    res.data.forEach((tx) => {
        let sum = 0;
        let hasAny = false;

        tx.vin.forEach((txin) => {
            if (txin.prevout.scriptpubkey_address === address) {
                sum -= txin.prevout.value;
                hasAny = true;
            }
        });

        if (hasAny) {
            out.push({
                "type": "out",
                "txid": tx.txid,
                "value": sum,
                "confirmed": tx.status.confirmed,
                "time": tx.status.block_time,
            });
        }
    });

    return out;
}

async function getUtxo(esploraAPI, address) {
    let res = await axios.get(esploraAPI + '/address/' + address + '/utxo');
    let utxo = res.data;

    utxo = utxo.filter(e => e.status.confirmed);

    return await Promise.all(
        utxo.map(async e => {
            let rawRes = await axios.get(esploraAPI + '/tx/' + e.txid + '/hex');
            return {txid: e.txid, vout: e.vout, value: e.value, raw: rawRes.data};
        }),
    );
}

function csvGetFinalScripts(
    network,
    inputIndex,
    input,
    script,
    isSegwit,
    isP2SH,
    isP2WSH,
) {
    let inputStack;

    if (input.partialSig.length === 1) {
        // there is a single signature, try to unlock input
        // using client's signature and OP_CHECKLOCKTIMEVERIFY
        console.log('csvGetFinalScripts(): Using single signature variant.');
        inputStack = bitcoin.script.compile([
            input.partialSig[0].signature,
            bitcoin.opcodes.OP_TRUE,
        ]);
    } else if (input.partialSig.length === 2) {
        // there are two signatures, try to unlock
        // using normal multisig client+server
        console.log('csvGetFinalScripts(): Using multiple signature variant.');
        inputStack = bitcoin.script.compile([
            input.partialSig[1].signature,
            input.partialSig[0].signature,
            bitcoin.opcodes.OP_FALSE,
        ]);
    } else {
        throw new Error('Invalid number of signatures.');
    }

    let innerPayment = {
        input: inputStack,
        network: network,
        output: script,
    };

    let payment = bitcoin.payments.p2sh({
        network: network,
        redeem: innerPayment,
    });

    return {finalScriptSig: payment.input};
}

function createTx(
    network,
    payment,
    utxo,
    impServerKey,
    impClientKey,
    lockTimeTs,
    targetAddress,
    feeAmount,
) {
    console.log('createTx(): Fee amount', feeAmount);
    let sum = 0;

    const psbt = new bitcoin.Psbt({network: network});

    psbt.setVersion(2);

    if (!impServerKey.privateKey) {
        psbt.setLocktime(lockTimeTs);
    }

    utxo.forEach(e => {
        psbt.addInput({
            hash: e.txid,
            index: e.vout,
            sequence: !impServerKey.privateKey ? 0xfffffffe : undefined,
            nonWitnessUtxo: Buffer.from(e.raw, 'hex'),
            redeemScript: payment.redeem.output,
        });

        sum += e.value;
    });

    psbt.addOutput({
        address: targetAddress,
        value: sum - feeAmount,
    });

    if (impServerKey.privateKey) {
        utxo.forEach((_, idx) => {
            psbt.signInput(idx, impServerKey);
        });
    }

    utxo.forEach((_, idx) => {
        psbt.signInput(idx, impClientKey);
    });

    if (!psbt.validateSignaturesOfAllInputs()) {
        throw new Error('Failed to validate input signatures');
    }

    for (let i = 0; i < psbt.inputCount; i++) {
        psbt.finalizeInput(i, csvGetFinalScripts.bind(null, network));
    }

    return psbt.extractTransaction();
}

function createTxDryRun(
    network,
    payment,
    utxo,
    numSignatures,
    lockTimeTs
) {
    let sum = 0;

    const psbt = new bitcoin.Psbt({network: network});

    psbt.setVersion(2);
    psbt.setLocktime(lockTimeTs);

    utxo.forEach(e => {
        psbt.addInput({
            hash: e.txid,
            index: e.vout,
            sequence: 0xfffffffe,
            nonWitnessUtxo: Buffer.from(e.raw, 'hex'),
            redeemScript: payment.redeem.output,
        });

        sum += e.value;
    });

    psbt.addOutput({
        address: payment.address,
        value: sum,
    });

    utxo.forEach((_, idx) => {
        psbt.data.inputs[idx].partialSig = [];

        for (let i = 0; i < numSignatures; i++) {
            // append artificial signatures for simulation
            psbt.data.inputs[idx].partialSig.push({
                "pubkey": Buffer.from("00".repeat(33), "hex"),
                "signature": Buffer.from("00".repeat(72), "hex")
            });
        }
    });

    for (let i = 0; i < psbt.inputCount; i++) {
        psbt.finalizeInput(i, csvGetFinalScripts.bind(null, network));
    }

    return psbt.extractTransaction();
}

async function estimateTxFee(
    esploraAPI,
    network,
    serverPublicKey,
    clientPublicKey,
    lockTimeTs,
    numSignatures
) {
    let payment = getMultisigPayment(
        network,
        serverPublicKey,
        clientPublicKey,
        lockTimeTs,
    );
    let utxo = await getUtxo(esploraAPI, payment.address);
    let fees = await getRecommendedFee(esploraAPI);

    let dryTx = createTxDryRun(
        network,
        payment,
        utxo,
        numSignatures,
        lockTimeTs
    );

    return {
        txVirtualSize: dryTx.virtualSize(),
        feesPerVb: fees
    };
}

async function sendFromMultisig(
    esploraAPI,
    network,
    impServerKey,
    impClientKey,
    lockTimeTs,
    targetAddress,
    txFeeType,
) {
    let payment = getMultisigPayment(
        network,
        impServerKey.publicKey,
        impClientKey.publicKey,
        lockTimeTs,
    );
    let utxo = await getUtxo(esploraAPI, payment.address);
    let fees = await getRecommendedFee(esploraAPI);

    if (!txFeeType || !fees.hasOwnProperty(txFeeType)) {
        throw new Error("Unable to fetch recommended fee.");
    }

    let feeRate = fees[txFeeType];

    let dryTx = createTx(
        network,
        payment,
        utxo,
        impServerKey,
        impClientKey,
        lockTimeTs,
        targetAddress,
        0,
    );
    let feeAmount = Math.ceil(dryTx.virtualSize() * feeRate);
    let tx = createTx(
        network,
        payment,
        utxo,
        impServerKey,
        impClientKey,
        lockTimeTs,
        targetAddress,
        feeAmount,
    );

    let res;

    try {
        res = await axios.post(esploraAPI + '/tx', tx.toHex());
    } catch (e) {
        let detailsMsg = e.response && e.response.data ? e.response.data : e.toString();
        throw new Error("Failed to send transaction for broadcast: " + detailsMsg);
    }

    return res.data; // txid
}

async function generateTransfer(esploraAPI, network, serverPrivKey, oldClientPubKey, newClientPubKey, nominalValueSat, lockTimeTs) {
    const impServerKey = ECPair.fromPrivateKey(serverPrivKey);

    let payment = getMultisigPayment(network, impServerKey.publicKey, oldClientPubKey, lockTimeTs);
    let paymentNew = getMultisigPayment(network, impServerKey.publicKey, newClientPubKey, lockTimeTs);

    console.log('generateTransfer(): old addr', payment.address);
    console.log('generateTransfer(): new addr', paymentNew.address);

    let utxo = await getUtxo(esploraAPI, payment.address);
    let sum = 0;

    let addedInputs = [];
    let addedOutputs = []

    const psbt = new bitcoin.Psbt({network: network});
    psbt.setVersion(2);
    psbt.setLocktime(0);
    utxo.forEach((e) => {
        let inp = {
            hash: e.txid,
            index: e.vout,
            nonWitnessUtxo: Buffer.from(e.raw, 'hex'),
            redeemScript: payment.redeem.output,
        };
        psbt.addInput(inp);
        addedInputs.push(inp);

        sum += e.value;
    });

    console.log('generateTransfer(): input sum: ' + sum + ', output val: ' + nominalValueSat);

    if (sum <= nominalValueSat) {
        throw new Error("Failed to generate positive-sum transaction.");
    }

    let out = {
        address: paymentNew.address,
        value: nominalValueSat,
    };
    psbt.addOutput(out);
    addedOutputs.push(out);
    utxo.forEach((_, idx) => {
        psbt.signInput(idx, impServerKey);
    });

    if (!psbt.validateSignaturesOfAllInputs()) {
        throw new Error("Failed to validate signatures.");
    }

    return {
        "inputs": addedInputs,
        "outputs": addedOutputs,
        "sig": psbt.data.inputs.map((inp) => inp.partialSig),
    }
}

module.exports = {
    privKeyToPublic,
    getMultisigPayment,
    checkAddressBalance,
    getUtxo,
    generateTransfer,
    sendFromMultisig,
    csvGetFinalScripts,
    analyseTransfersOnAddress,
    estimateTxFee
};
