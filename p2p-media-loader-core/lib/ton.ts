import TonWeb from "tonweb";

const BN = TonWeb.utils.BN;

// Blockchain does not operate with fractional numbers like `0.5`.
// `toNano` function converts TON to nanoton - smallest unit.
// 1 TON = 10^9 nanoton; 1 nanoton = 0.000000001 TON;
// So 0.5 TON is 500000000 nanoton

const toNano = TonWeb.utils.toNano;

const providerUrl = 'https://testnet.toncenter.com/api/v2/jsonRPC'; // TON HTTP API url. Use this url for testnet
const apiKey = 'd3294baee115df52d0eea887a2bccd490bae9920fa3007c11dd2a08bc0ebfed2'; // Obtain your API key in https://t.me/tontestnetapibot
const tonweb = new TonWeb(new TonWeb.HttpProvider(providerUrl, {apiKey})); // Initialize TON SDK

// Platform private key
const platformSeed = TonWeb.utils.base64ToBytes('N0OYilsVc4Q5mxqZLYz8svwe4rGO6l3tAhlYYC6vI1A=');
const platformKeyPair = (tonweb.utils as any).keyPairFromSeed(platformSeed);
// const platformAddress = "EQBEmx4YDnG1lnVvPT80NN83B2TeOpWkT9Ht9FIt_caInd4T";

type TonClientData = { address: string, keyPair: { publicKey: Uint8Array, secretKey: Uint8Array } };

let tonClientData: TonClientData;
let tonInitializing: Promise<TonClientData>;
export async function initTon(): Promise<TonClientData> {
    if (tonClientData) {
        return tonClientData;
    }
    if (tonInitializing) {
        return tonInitializing;
    }
    tonInitializing = (async () => {
        try {
            await new Promise((resolve) => {setTimeout(resolve, 1000)});
            let seedB64 = localStorage.getItem("seed");
            if (!seedB64) {
                seedB64 = prompt('Please enter your seed base64: ');
            }
            if (!seedB64) {
                throw new Error("Seed is required");
            }
            const keyPair = (tonweb.utils as any).keyPairFromSeed(tonweb.utils.base64ToBytes(seedB64 as string));

            let address = localStorage.getItem("address");
            if (!address) {
                address = prompt("Please enter your wallet address: ") as string;
            }
            if (!address) {
                throw new Error("Address is required");
            }
            tonClientData = {
                keyPair,
                address,
            };
            localStorage.setItem("seed", seedB64);
            localStorage.setItem("address", address);
        } catch (err) {
            alert("Failed to initialize TON client: " + err.message);
            return await initTon();
        }

        return tonClientData;
    })();
    return tonInitializing;
}

// Оплата за раздачу
// 1. Потенциальный сид запрашивает адрес и публичный ключ платформы
// 2. Потенциальный сид деплоит платежный канал
// 3. Потенциальный сид отправляет платежный канал платформе
// 4. Сид отправляет платформе данные о том сколько трафика передал личам
// 5. Платформа проверяет подлинность данных и отправляет сиду оплату по платежному каналу
//      Есть некий способ проверить подлинность предоставляемых данных
// Платформе выгодно иметь очень дешевый cdn
// Сиду выгодно получать деньги за то, что он сам смотрит

const PRICE_PER_MB = 0.01;

async function secondDelay() {
    await new Promise(r => setTimeout(r, 1000));
}

enum CHState {
    UNINITED = 0,
    OPEN = 1,
    CLOSURE_STARTED = 2,
    SETTLING_CONDITIONALS = 3,
    AWAITING_FINALIZATION = 4,
}

export async function getMoneyForSeeding (mb: number) {
    await initTon();
    const keyPairA = tonClientData.keyPair;
    const keyPairB = platformKeyPair;

    const walletA = tonweb.wallet.create({
        publicKey: tonClientData.keyPair.publicKey
    });
    const walletAddressA = await walletA.getAddress(); // address of this wallet in blockchain
    console.log('walletAddressA = ', walletAddressA.toString(true, true, true));

    const walletB = tonweb.wallet.create({
        publicKey: keyPairB.publicKey,
    });
    const walletAddressB = await walletB.getAddress(); // address of this wallet in blockchain
    console.log('walletAddressB = ', walletAddressB.toString(true, true, true));

    const channelInitState = {
        balanceA: toNano('0'), // A's initial balance in Toncoins. Next A will need to make a top-up for this amount
        balanceB: toNano('1'), // B's initial balance in Toncoins. Next B will need to make a top-up for this amount
        seqnoA: new BN(0), // initially 0
        seqnoB: new BN(0)  // initially 0
    };

    const channelConfig = {
        channelId: new BN(221454227), // Channel ID, for each new channel there must be a new ID
        addressA: walletAddressA, // A's funds will be withdrawn to this wallet address after the channel is closed
        addressB: walletAddressB, // B's funds will be withdrawn to this wallet address after the channel is closed
        initBalanceA: channelInitState.balanceA,
        initBalanceB: channelInitState.balanceB
    }

    const channelA = (tonweb as any).payments.createChannel({
        ...channelConfig,
        isA: true,
        myKeyPair: keyPairA,
        hisPublicKey: keyPairB.publicKey,
    });
    const channelAddress = await channelA.getAddress(); // address of this payment channel smart-contract in blockchain
    console.log('channelAddress=', channelAddress.toString(true, true, true));

    const channelB = (tonweb as any).payments.createChannel({
        ...channelConfig,
        isA: false,
        myKeyPair: keyPairB,
        hisPublicKey: keyPairA.publicKey,
    });

    if ((await channelB.getAddress()).toString() !== channelAddress.toString()) {
        throw new Error('Channels address not same');
    }

    const fromWalletA = channelA.fromWallet({
        wallet: walletA,
        secretKey: keyPairA.secretKey
    });

    const fromWalletB = channelB.fromWallet({
        wallet: walletB,
        secretKey: keyPairB.secretKey
    });


    let state: CHState | undefined = undefined;

    try {
        state = await channelA.getChannelState()
    } catch (err) {
        // deploy if not deployed
        console.log("DEPLOYING CHANNEL");
        await fromWalletA.deploy(tonClientData.keyPair.secretKey).send(toNano('0.05'));
        console.log("Deployed ch");
    }

    if (state === undefined) {
        while (true) {
            await secondDelay();
            try {
                console.log("getting ch state");
                state = await channelA.getChannelState()
                console.log("CHSTATE", state);
                if (state !== undefined) {
                    // If we've got state we can continue initialization of Payment Channel
                    break;
                }
            } catch (err) {
                //  not deployed to nodes yet
                continue
            }
        }
    }
    if (state !== CHState.OPEN) {
        console.log("TOPING UPP");
        // TODO: It's possible that other state may be there
        // It looks that it's not required to top up from wallet A since it's already deployed the contract
        await fromWalletB
            .topUp({coinsA: new BN(0), coinsB: channelInitState.balanceB})
            .send(channelInitState.balanceB.add(toNano('0.05'))); // +0.05 TON to network fees

        await secondDelay();

        await fromWalletA.init(channelInitState).send(toNano('0.05'));

        while (true) {
            await secondDelay();
            try {
                console.log("getting ch state");
                state = await channelA.getChannelState()
                console.log("CHSTATE", state);
                console.log("getting ch data");
                if (state === CHState.OPEN) {
                    break;
                }
            } catch (err) {
                //  not topupted yet
                continue
            }
        }
    }


    const price = toNano((PRICE_PER_MB * mb)  + "");
    console.log("CHANNEL STATE", {
        state,
        price: price.toString(),
    });
    const channelState1 = {
        balanceA: channelInitState.balanceA.add(price),
        balanceB: channelInitState.balanceB.sub(price),
        seqnoA: new BN(0),
        seqnoB: new BN(2)
    };

    console.log("channelState1.balanceA", channelState1.balanceA.toString());
    console.log("channelState1.balanceB", channelState1.balanceB.toString());

    const signatureB1 = await channelB.signState(channelState1);

    if (!(await channelA.verifyState(channelState1, signatureB1))) {
        throw new Error('Invalid B signature');
    }

    const signatureCloseB = await channelB.signClose(channelState1);
    if (!(await channelA.verifyClose(channelState1, signatureCloseB))) {
        throw new Error('Invalid B signature');
    }
    // DONE CHANNEL
    await fromWalletA.close({
        ...channelState1,
        hisSignature: signatureCloseB,
    }).send(toNano('0.05'));

    const signatureCloseA = await channelA.signClose(channelState1);
    if (!(await channelB.verifyClose(channelState1, signatureCloseA))) {
        throw new Error('Invalid B signature');
    }
    await fromWalletB.close({
        ...channelState1,
        hisSignature: signatureCloseA,
    }).send(toNano('0.05'));

    while (true) {
        await secondDelay();
        const d = await channelA.getData();
        console.log(d)
        console.log("bb", d.balanceB.toString())
        console.log("ba", d.balanceA.toString())
    }
}
