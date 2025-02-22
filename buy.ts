import {
  BigNumberish,
  Liquidity,
  LIQUIDITY_STATE_LAYOUT_V4,
  LiquidityPoolKeys,
  LiquidityStateV4,
  MARKET_STATE_LAYOUT_V3,
  MarketStateV3,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk';
import BN from 'bn.js'
import {
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  Keypair,
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  KeyedAccountInfo,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { getTokenAccounts, RAYDIUM_LIQUIDITY_PROGRAM_ID_V4, OPENBOOK_PROGRAM_ID, createPoolKeys } from './liquidity';
import { logger } from './utils';
import { getMinimalMarketV3, MinimalMarketLayoutV3 } from './market';
import { MintLayout } from './types';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import {
  AUTO_SELL,
  AUTO_SELL_DELAY,
  CHECK_IF_MINT_IS_RENOUNCED,
  CHECK_IF_FREEZEAUTHORITY_IS_RENOUNCED,
  CHECK_IF_METADATA_IS_MUTABLE,
  CHECK_IF_TOKEN_SECURITY,
  COMMITMENT_LEVEL,
  LOG_LEVEL,
  MAX_SELL_RETRIES,
  NETWORK,
  PRIVATE_KEY,
  HELIUS_KEY,
  BIRD_KEY,
  QUOTE_AMOUNT,
  QUOTE_MINT,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  SNIPE_LIST_REFRESH_INTERVAL,
  USE_SNIPE_LIST,
  MIN_POOL_SIZE,
} from './constants';

let solanaConnection: Connection;

try {
  solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});

} catch (error) {
  logger.error("Erreur lors de la connexion à Solana :", error);
  process.exit(1); // Arrêter le programme en cas d'échec de connexion
}

export interface MinimalTokenAccountData {
  mint: PublicKey;
  address: PublicKey;
  poolKeys?: LiquidityPoolKeys;
  market?: MinimalMarketLayoutV3;
}

const existingLiquidityPools: Set<string> = new Set<string>();
const existingOpenBookMarkets: Set<string> = new Set<string>();
const existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>();

let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
let quoteMinPoolSizeAmount: TokenAmount;

let purchaseRecords:{[mint: string]: number[] } = {};

let snipeList: string[] = [];

async function init(): Promise<void> {
  logger.level = LOG_LEVEL;

  // get wallet
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  logger.info(`Wallet Address: ${wallet.publicKey}`);

  // get quote mint and amount
  switch (QUOTE_MINT) {
    case 'WSOL': {
      quoteToken = Token.WSOL;
      quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false);
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
      break;
    }
    case 'USDC': {
      quoteToken = new Token(
        TOKEN_PROGRAM_ID,
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        6,
        'USDC',
        'USDC',
      );
      quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false);
      quoteMinPoolSizeAmount = new TokenAmount(quoteToken, MIN_POOL_SIZE, false);
      break;
    }
    default: {
      throw new Error(`Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`);
    }
  }

  logger.info(`Snipe list: ${USE_SNIPE_LIST}`);
  logger.info(`Check mint renounced: ${CHECK_IF_MINT_IS_RENOUNCED}`);
  logger.info(
    `Min pool size: ${quoteMinPoolSizeAmount.isZero() ? 'false' : quoteMinPoolSizeAmount.toFixed()} ${quoteToken.symbol}`,
  );
  logger.info(`Buy amount: ${quoteAmount.toFixed()} ${quoteToken.symbol}`);
  logger.info(`Auto sell: ${AUTO_SELL}`);
  logger.info(`Sell delay: ${AUTO_SELL_DELAY === 0 ? 'false' : AUTO_SELL_DELAY}`);

  // check existing wallet for associated token account of quote mint
  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, COMMITMENT_LEVEL);

  for (const ta of tokenAccounts) {
    existingTokenAccounts.set(ta.accountInfo.mint.toString(), <MinimalTokenAccountData>{
      mint: ta.accountInfo.mint,
      address: ta.pubkey,
    });
  }

  const tokenAccount = tokenAccounts.find((acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString())!;

  if (!tokenAccount) {
    throw new Error(`No ${quoteToken.symbol} token account found in wallet: ${wallet.publicKey}`);
  }

  quoteTokenAssociatedAddress = tokenAccount.pubkey;

  // load tokens to snipe
  loadSnipeList();
}

function saveTokenAccount(mint: PublicKey, accountData: MinimalMarketLayoutV3) {
  const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const tokenAccount = <MinimalTokenAccountData>{
    address: ata,
    mint: mint,
    market: <MinimalMarketLayoutV3>{
      bids: accountData.bids,
      asks: accountData.asks,
      eventQueue: accountData.eventQueue,
    },
  };
  existingTokenAccounts.set(mint.toString(), tokenAccount);
  return tokenAccount;
}

export async function processRaydiumPool(id: PublicKey, poolState: LiquidityStateV4) {
  if (!shouldBuy(poolState.baseMint.toString())) {
    return;
  }

  if (!quoteMinPoolSizeAmount.isZero()) {
    const poolSize = new TokenAmount(quoteToken, poolState.swapQuoteInAmount, true);
    logger.info(`Processing pool: ${id.toString()} with ${poolSize.toFixed()} ${quoteToken.symbol} in liquidity`);

    if (poolSize.lt(quoteMinPoolSizeAmount)) {
      logger.warn(
        {
          mint: poolState.baseMint,
          pooled: `${poolSize.toFixed()} ${quoteToken.symbol}`,
        },
        `Skipping pool, smaller than ${quoteMinPoolSizeAmount.toFixed()} ${quoteToken.symbol}`,
        `Swap quote in amount: ${poolSize.toFixed()}`,
      );
      return;
    }
  }

  if (CHECK_IF_MINT_IS_RENOUNCED) {
    const mintOption = await checkMintable(poolState.baseMint);

    if (mintOption !== true) {
      logger.warn({ mint: poolState.baseMint }, 'Skipping, owner can mint tokens!');
      return;
    }
  }
  if (CHECK_IF_FREEZEAUTHORITY_IS_RENOUNCED) {
    const mintOption = await checkFreezeAuthority(poolState.baseMint);

    if (mintOption !== true) {
      logger.warn({ mint: poolState.baseMint }, 'Skipping, owner can Freeze tokens!');
      return;
    }
  }
  if (CHECK_IF_METADATA_IS_MUTABLE) {
    const isMutable = await checkMetadataIsMutable(poolState.baseMint);
    if (isMutable !== false) {
      logger.warn({ mint: poolState.baseMint }, 'Skipping, owner can mutable metadata !');
      return;
    }
  }

  if (CHECK_IF_TOKEN_SECURITY) {
    const isSecurity = await checkTokenSecurity(poolState.baseMint);
    console.log('la fonction security retourne :',isSecurity)

    if (isSecurity !== true) {
      logger.warn({ mint: poolState.baseMint }, 'Skipping, is not secure !');
      return;
    }
  }

  await buy(id, poolState);
}
export async function checkTokenSecurity(vault: PublicKey): Promise<boolean | undefined> {

const nftAddresses: string[] = [vault.toString()] 
const url: string = `https://public-api.birdeye.so/defi/token_security?address=${nftAddresses}`;

  try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'x-chain':'solana','X-API-KEY': BIRD_KEY },
      });

      const result = await response.json();
      const data = result.data;

      //if (data.mutableMetadata!==false){
      //console.log("mutableMetadata :",data.mutableMetadata)
      //return false 
      //}
      console.log("mutableMetadata :",data.mutableMetadata)
      if (data.freezeable==true){
      console.log("freezeable :",data.freezeable)
      return false  
      }
      if (data.top10HolderPercent >= 0.91){
      console.log("top10HolderPercent: ",data.top10HolderPercent)
      return false
      }     console.log("freezeable :",data.freezeable)
      //if (data.metaplexUpdateAuthorityPercent >= 0.01){
      //console.log("metaplexUpdateAuthorityPercent : ",data.metaplexUpdateAuthorityPercent)
      //return false
      //}
      //console.log("metaplexUpdateAuthorityPercent :",data.metaplexUpdateAuthorityPercent)


      
    
    // Si nous n'avons pas trouvé d'objet correspondant ou si 'isMutable' n'est pas défini,
    // on retourne 'undefined' pour indiquer l'absence de résultat définitif.
    return true;

  }  catch (e) {
    logger.debug(e);
    logger.error({ mint: vault }, `Failed to check checking token metadata`);
    return false
  }
}

export async function checkMetadataIsMutable(vault: PublicKey): Promise<boolean | undefined> {

const url: string = `https://api.helius.xyz/v0/token-metadata?api-key=${HELIUS_KEY}`;
const nftAddresses: string[] = [vault.toString()] 

  try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mintAccounts: nftAddresses,
          includeOffChain: false,
          disableCache: false,
        }),
      });
      const data = await response.json();
   for (const item of data) {
      if (item.onChainMetadata && item.onChainMetadata.metadata && item.onChainMetadata.metadata.isMutable !== undefined) {
        return item.onChainMetadata.metadata.isMutable;
      }
    }
    
    // Si nous n'avons pas trouvé d'objet correspondant ou si 'isMutable' n'est pas défini,
    // on retourne 'undefined' pour indiquer l'absence de résultat définitif.
    return undefined;

  }  catch (e) {
    logger.debug(e);
    logger.error({ mint: vault }, `Failed to check checking token metadata`);
    return undefined
  }
}
export async function checkFreezeAuthority(vault: PublicKey): Promise<boolean | undefined> {
  try {
    let { data } = (await solanaConnection.getAccountInfo(vault)) || {};
    if (!data) {
      return;
    }
    const deserialize = MintLayout.decode(data);
    return deserialize.freezeAuthorityOption === 0;
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: vault }, `Failed to check if freeze authority option is renounced`);
  }
}

export async function checkMintable(vault: PublicKey): Promise<boolean | undefined> {
  try {
    let { data } = (await solanaConnection.getAccountInfo(vault)) || {};
    if (!data) {
      return;
    }
    const deserialize = MintLayout.decode(data);
    return deserialize.mintAuthorityOption === 0;
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: vault }, `Failed to check if mint is renounced`);
  }
}

export async function processOpenBookMarket(updatedAccountInfo: KeyedAccountInfo) {
  let accountData: MarketStateV3 | undefined;
  try {
    accountData = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);

    // to be competitive, we collect market data before buying the token...
    if (existingTokenAccounts.has(accountData.baseMint.toString())) {
      return;
    }

    saveTokenAccount(accountData.baseMint, accountData);
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: accountData?.baseMint }, `Failed to process market`);
  }
}

async function buy(accountId: PublicKey, accountData: LiquidityStateV4): Promise<void> {
  try {
    let tokenAccount = existingTokenAccounts.get(accountData.baseMint.toString());

    if (!tokenAccount) {
      // it's possible that we didn't have time to fetch open book data
      const market = await getMinimalMarketV3(solanaConnection, accountData.marketId, COMMITMENT_LEVEL);
      tokenAccount = saveTokenAccount(accountData.baseMint, market);
    }

    tokenAccount.poolKeys = createPoolKeys(accountId, accountData, tokenAccount.market!);

    const currentPurchasePrice = await getCurrentPrice(accountData.baseMint);
      if (currentPurchasePrice === undefined) {
        console.error('Purchase price could not be fetched.');
        return;
      }
  // Storing both mint and purchase price
  const mint = (accountData.baseMint).toString();  // Assuming baseMint is the mint address you're interested in
  if (!purchaseRecords[mint]) {
    purchaseRecords[mint] = [];
  }
  purchaseRecords[mint].push(currentPurchasePrice);

    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: tokenAccount.poolKeys,
        userKeys: {
          tokenAccountIn: quoteTokenAssociatedAddress,
          tokenAccountOut: tokenAccount.address,
          owner: wallet.publicKey,
        },
        amountIn: quoteAmount.raw,
        minAmountOut: 0,
      },
      tokenAccount.poolKeys.version,
    );

    const latestBlockhash = await solanaConnection.getLatestBlockhash({
      commitment: COMMITMENT_LEVEL,
    });

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 421197 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 101337 }),
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          tokenAccount.address,
          wallet.publicKey,
          accountData.baseMint,
        ),
        ...innerTransaction.instructions,
      ],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);
    const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
      preflightCommitment: COMMITMENT_LEVEL,
    });
    logger.info({ mint: accountData.baseMint, signature }, `Sent buy tx`);
    const confirmation = await solanaConnection.confirmTransaction(
      {
        signature,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        blockhash: latestBlockhash.blockhash,
      },
      COMMITMENT_LEVEL,
    );
    if (!confirmation.value.err) {
      logger.info(
        {
          mint: accountData.baseMint,
          signature,
          url: `https://solscan.io/tx/${signature}?cluster=${NETWORK}`,
        },
        `Confirmed buy tx`,
      );

    } else {
      logger.debug(confirmation.value.err);
      logger.info({ mint: accountData.baseMint, signature }, `Error confirming buy tx`);
    }
  } catch (e) {
    logger.debug(e);
    logger.error({ mint: accountData.baseMint }, `Failed to buy token`);
  }
}

 export async function getCurrentPrice(vault:PublicKey): Promise<number | undefined>
{
const addressSol = "So11111111111111111111111111111111111111112"
const nftAddresses: string[] = [vault.toString()] 
const urltoken: string = `https://public-api.birdeye.so/defi/price?address=${nftAddresses}`;
const urlsol: string = `https://public-api.birdeye.so/defi/price?address=${addressSol}`;

  async function getTokenPrice(url:string): Promise<number | undefined>{
  try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'x-chain':'solana','X-API-KEY': BIRD_KEY },
      });

      const result = await response.json();
      const data = result.data;
      return data.value
    }catch (e) {
    logger.debug(e);
    logger.error({ mint: vault }, `Failed to check token price`);
    return undefined 
  }
  }
  const solValuePromise = getTokenPrice(urlsol);
  const tokenValuePromise = getTokenPrice(urltoken);
  await new Promise (resolve => setTimeout(resolve,5000))

  const solValue = await solValuePromise;
  const tokenValue = await tokenValuePromise;

  if (solValue === undefined || tokenValue === undefined) {
    return undefined;  // Returns undefined if either value is undefined
  }

  const result = tokenValue / solValue;
  return result;
  
}


async function sell( accountId: PublicKey,mint: PublicKey, amount: BigNumberish): Promise<void> {
  let sold = false;
  let retries = 0;
  let remainingAmount = amount; 
  let totalProfit = 0;
  let totalLoss = 0 ;

  const purchasePrice = Number(purchaseRecords[mint.toString()])
  // Définir les seuils de vente et pourcentages de sortie
  const exitLevels = [
    { threshold: 0.04, percentage: 10 },  // Seuil 1: +10% de gain, vendre 10%
   // { threshold: 1.02, percentage: 15 },  // Seuil 2: +20% de gain, vendre 15% 
   // { threshold: 1.05, percentage: 25 },  // Seuil 3: +50% de gain, vendre 25%
   // { threshold: 1.10, percentage: 50 }   // Seuil 4: +100% de gain, vendre 50% du reste
  ];

  // Récupérer le prix d'achat initial
  //const purchasePrice = Number(QUOTE_AMOUNT)/Number(amount); // à remplacer par la vraie valeur

  if (AUTO_SELL_DELAY > 0) {
    await new Promise((resolve) => setTimeout(resolve, AUTO_SELL_DELAY));
  }

  do {
    try {
      const tokenAccount = existingTokenAccounts.get(mint.toString());

      if (!tokenAccount) {
        return;
      }

      if (!tokenAccount.poolKeys) {
        logger.warn({ mint }, 'No pool keys found');
        return;
      }
    const currentPrice = await getCurrentPrice(mint);
    if (currentPrice === undefined) {
      console.error('Current price could not be fetched.');
      return;
    }

    const currentGain = (currentPrice - purchasePrice) / purchasePrice;
    console.log(`Current gain: ${(currentGain * 100)}% mint : ${mint}`);  // Log the current gain percentage
    
    for (const level of exitLevels) {

      if (currentGain >= level.threshold) {
        const amountAsNumber = new BN(amount.toString()).toNumber();
        const quantityToSell = Math.floor(amountAsNumber * (level.percentage / 100));

        console.log("quantityToSell: ",quantityToSell)
        const remainingAmountAsNumber = new BN(remainingAmount.toString()).toNumber();
        remainingAmount = new BN(remainingAmountAsNumber - quantityToSell);

      const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
        {
          poolKeys: tokenAccount.poolKeys!,
          userKeys: {
            tokenAccountOut: quoteTokenAssociatedAddress,
            tokenAccountIn: tokenAccount.address,
            owner: wallet.publicKey,
          },
          amountIn: amount,
          minAmountOut: 0,
        },
        tokenAccount.poolKeys!.version,
      );

      const latestBlockhash = await solanaConnection.getLatestBlockhash({
        commitment: COMMITMENT_LEVEL,
      });
      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 421197 }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: 101337 }),
          ...innerTransaction.instructions,
          createCloseAccountInstruction(tokenAccount.address, wallet.publicKey, wallet.publicKey),
        ],
      }).compileToV0Message();
      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([wallet, ...innerTransaction.signers]);
      const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
        preflightCommitment: COMMITMENT_LEVEL,
      });
      logger.info({ mint, signature }, `Sent sell tx`);
      const confirmation = await solanaConnection.confirmTransaction(
        {
          signature,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
          blockhash: latestBlockhash.blockhash,
        },
        COMMITMENT_LEVEL,
      );
      if (confirmation.value.err) {
        logger.debug(confirmation.value.err);
        logger.info({ mint, signature }, `Error confirming sell tx`);
        continue;
      }

      logger.info(
        {
          dex: `https://dexscreener.com/solana/${mint}?maker=${wallet.publicKey}`,
          mint,
          signature,
          url: `https://solscan.io/tx/${signature}?cluster=${NETWORK}`,
          sell: `Sold ${quantityToSell} tokens at exit level ${level.threshold} (+${level.threshold*100-100}%)`,
        },
        `Confirmed sell tx`,
      );
      if (currentGain >= 0) {
        totalProfit += quantityToSell * currentPrice;
      } else {
      totalLoss += quantityToSell * purchasePrice;
      }
      const profitLossRatio = totalProfit / totalLoss;
      console.log(`Profit/Loss Ratio: ${profitLossRatio.toFixed(2)}`); 

          break;
        }
      }
      if (remainingAmount ===0)
      {
      sold = true;
      }
    } catch (e: any) {
      // wait for a bit before retrying
      await new Promise((resolve) => setTimeout(resolve, 10000));
      retries++;
      logger.debug(e);
      logger.error({ mint }, `Failed to sell token, retry: ${retries}/${MAX_SELL_RETRIES}`);
    }
  } while (!sold && retries < MAX_SELL_RETRIES);
}

function loadSnipeList() {
  if (!USE_SNIPE_LIST) {
    return;
  }

  const count = snipeList.length;
  const data = fs.readFileSync(path.join(__dirname, 'snipe-list.txt'), 'utf-8');
  snipeList = data
    .split('\n')
    .map((a) => a.trim())
    .filter((a) => a);

  if (snipeList.length != count) {
    logger.info(`Loaded snipe list: ${snipeList.length}`);
  }
}

function shouldBuy(key: string): boolean {
  return USE_SNIPE_LIST ? snipeList.includes(key) : true;
}

const runListener = async () => {
  await init();
  const runTimestamp = Math.floor(new Date().getTime() / 1000);
  const raydiumSubscriptionId = solanaConnection.onProgramAccountChange(
    RAYDIUM_LIQUIDITY_PROGRAM_ID_V4,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
      const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
      const existing = existingLiquidityPools.has(key);

      if (poolOpenTime > runTimestamp && !existing) {
        existingLiquidityPools.add(key);
        const _ = processRaydiumPool(updatedAccountInfo.accountId, poolState);
      }
    },
    COMMITMENT_LEVEL,
    [
      { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
          bytes: OPENBOOK_PROGRAM_ID.toBase58(),
        },
      },
      {
        memcmp: {
          offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'),
          bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
        },
      },
    ],
  );

  const openBookSubscriptionId = solanaConnection.onProgramAccountChange(
    OPENBOOK_PROGRAM_ID,
    async (updatedAccountInfo) => {
      const key = updatedAccountInfo.accountId.toString();
      const existing = existingOpenBookMarkets.has(key);
      if (!existing) {
        existingOpenBookMarkets.add(key);
        const _ = processOpenBookMarket(updatedAccountInfo);
      }
    },
    COMMITMENT_LEVEL,
    [
      { dataSize: MARKET_STATE_LAYOUT_V3.span },
      {
        memcmp: {
          offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
          bytes: quoteToken.mint.toBase58(),
        },
      },
    ]
  )
  
  if (AUTO_SELL) {
    const walletSubscriptionId = solanaConnection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
          async (updatedAccountInfo) => {
        const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo!.data);

        if (updatedAccountInfo.accountId.equals(quoteTokenAssociatedAddress)) {
          return;
        }

        const _ = sell(updatedAccountInfo.accountId, accountData.mint, accountData.amount);
      },
      COMMITMENT_LEVEL,
      [
        {
          dataSize: 165,
        },
        {
          memcmp: {
            offset: 32,
            bytes: wallet.publicKey.toBase58(),
          },
        },
      ],
    );
    logger.info(`Listening for wallet changes: ${walletSubscriptionId}`);
  }


  logger.info(`Listening for raydium changes: ${raydiumSubscriptionId}`);
  logger.info(`Listening for open book changes: ${openBookSubscriptionId}`);

  if (USE_SNIPE_LIST) {
    setInterval(loadSnipeList, SNIPE_LIST_REFRESH_INTERVAL);
  }
};

runListener();
