import {
  ProviderRpcError,
  SwitchChainError,
  UserRejectedRequestError,
  type SignTypedDataParameters,
  getTypesForEIP712Domain,
  validateTypedData,
} from "viem";
import type { Address } from "abitype";
import { normalizeChainId } from "../utils/normalizeChainId.js";
import type { Account, SendTransactionOption } from "../interfaces/wallet.js";
import type { WCAutoConnectOptions, WCConnectOptions } from "./types.js";
import { getValidPublicRPCUrl } from "../utils/chains.js";
import { stringify } from "../../utils/json.js";
import type { EthereumProvider } from "@walletconnect/ethereum-provider";
import {
  defineChain,
  getChainMetadata,
  getRpcUrlForChain,
} from "../../chains/utils.js";
import type { Chain } from "../../chains/types.js";
import { isHex, numberToHex, type Hex } from "../../utils/encoding/hex.js";
import { getDefaultAppMetadata } from "../utils/defaultDappMetadata.js";
import type { WCSupportedWalletIds } from "../__generated__/wallet-ids.js";
import type { DisconnectFn, SwitchChainFn } from "../types.js";
import type { WalletEmitter } from "../wallet-emitter.js";
import { isAndroid, isIOS, isMobile } from "../../utils/web/isMobile.js";
import { openWindow } from "../../utils/web/openWindow.js";
import { getWalletInfo } from "../__generated__/getWalletInfo.js";
import { asyncLocalStorage as _asyncLocalStorage } from "../storage/asyncLocalStorage.js";

import {
  getSavedConnectParamsFromStorage,
  saveConnectParamsToStorage,
} from "../storage/walletStorage.js";
import type { ThirdwebClient } from "../../client/client.js";
import { getAddress } from "../../utils/address.js";

const asyncLocalStorage =
  typeof window !== "undefined" ? _asyncLocalStorage : undefined;

type WCProvider = InstanceType<typeof EthereumProvider>;

type SavedConnectParams = {
  optionalChains?: Chain[];
  chain?: Chain;
  pairingTopic?: string;
};

const defaultWCProjectId = "08c4b07e3ad25f1a27c14a4e8cecb6f0";

const NAMESPACE = "eip155";
const ADD_ETH_CHAIN_METHOD = "wallet_addEthereumChain";

const isNewChainsStale = true;
const defaultShowQrModal = true;

const storageKeys = {
  requestedChains: "tw.wc.requestedChains",
  lastUsedChainId: "tw.wc.lastUsedChainId",
};

/**
 * @internal
 */
export async function connectWC(
  options: WCConnectOptions,
  emitter: WalletEmitter<WCSupportedWalletIds>,
  walletId: WCSupportedWalletIds | "walletConnect",
): Promise<ReturnType<typeof onConnect>> {
  const provider = await initProvider(options, walletId);

  const _isChainsState = await isChainsStale(provider, [
    provider.chainId,
    ...(options?.walletConnect?.optionalChains || []).map((c) => c.id),
  ]);

  const wcOptions = options.walletConnect;

  const { onDisplayUri } = wcOptions || {};

  if (onDisplayUri) {
    if (onDisplayUri) {
      provider.events.addListener("display_uri", onDisplayUri);
    }
  }

  const { rpcMap, chainsToRequest } = getChainsToRequest({
    client: options.client,
    chain: options.chain,
    optionalChains: options.walletConnect?.optionalChains,
  });

  // If there no active session, or the chain is stale, force connect.
  if (!provider.session || _isChainsState) {
    await provider.connect({
      ...(wcOptions?.pairingTopic
        ? { pairingTopic: wcOptions?.pairingTopic }
        : {}),
      optionalChains: chainsToRequest,
      rpcMap: rpcMap,
    });

    setRequestedChainsIds(chainsToRequest);
  }

  // If session exists and chains are authorized, enable provider for required chain
  const addresses = await provider.enable();
  const address = addresses[0];
  if (!address) {
    throw new Error("No accounts found on provider.");
  }

  const chain = defineChain(normalizeChainId(provider.chainId));

  if (options) {
    const savedParams: SavedConnectParams = {
      optionalChains: options.walletConnect?.optionalChains,
      chain: options.chain,
      pairingTopic: options.walletConnect?.pairingTopic,
    };

    if (asyncLocalStorage) {
      saveConnectParamsToStorage(asyncLocalStorage, walletId, savedParams);
    }
  }

  if (wcOptions?.onDisplayUri) {
    provider.events.removeListener("display_uri", wcOptions.onDisplayUri);
  }

  return onConnect(address, chain, provider, emitter);
}

/**
 * Auto connect to already connected wallet connect session.
 * @internal
 */
export async function autoConnectWC(
  options: WCAutoConnectOptions,
  emitter: WalletEmitter<WCSupportedWalletIds>,
  walletId: WCSupportedWalletIds | "walletConnect",
): Promise<ReturnType<typeof onConnect>> {
  const savedConnectParams: SavedConnectParams | null = asyncLocalStorage
    ? await getSavedConnectParamsFromStorage(asyncLocalStorage, walletId)
    : null;

  const provider = await initProvider(
    savedConnectParams
      ? {
          chain: savedConnectParams.chain,
          client: options.client,
          walletConnect: {
            pairingTopic: savedConnectParams.pairingTopic,
            optionalChains: savedConnectParams.optionalChains,
          },
        }
      : {
          client: options.client,
          walletConnect: {},
        },
    walletId,
    true, // is auto connect
  );

  const address = provider.accounts[0];

  if (!address) {
    throw new Error("No accounts found on provider.");
  }

  const chain = defineChain(normalizeChainId(provider.chainId));

  return onConnect(address, chain, provider, emitter);
}

// /**
//  * @internal
//  */
// export async function disconnectWC(wallet: Wallet<WCSupportedWalletIds>) {
//   const provider = walletToProviderMap.get(wallet);
//   // const storage = getWalletData(wallet)?.storage;

//   onDisconnect(wallet);
//   // if (storage) {
//   //   deleteConnectParamsFromStorage(storage, wallet.id);
//   // }

//   if (provider) {
//     provider.disconnect();
//   }
// }

// Connection utils -----------------------------------------------------------------------------------------------

async function initProvider(
  options: WCConnectOptions,
  walletId: WCSupportedWalletIds | "walletConnect",
  isAutoConnect = false,
) {
  const walletInfo = await getWalletInfo(walletId);
  const wcOptions = options.walletConnect;
  const { EthereumProvider, OPTIONAL_EVENTS, OPTIONAL_METHODS } = await import(
    "@walletconnect/ethereum-provider"
  );

  const { rpcMap, chainsToRequest } = getChainsToRequest({
    client: options.client,
    chain: options.chain,
    optionalChains: options.walletConnect?.optionalChains,
  });

  const provider = await EthereumProvider.init({
    showQrModal:
      wcOptions?.showQrModal === undefined
        ? defaultShowQrModal
        : wcOptions.showQrModal,
    projectId: wcOptions?.projectId || defaultWCProjectId,
    optionalMethods: OPTIONAL_METHODS,
    optionalEvents: OPTIONAL_EVENTS,
    optionalChains: chainsToRequest,
    metadata: {
      name: wcOptions?.appMetadata?.name || getDefaultAppMetadata().name,
      description:
        wcOptions?.appMetadata?.description ||
        getDefaultAppMetadata().description,
      url: wcOptions?.appMetadata?.url || getDefaultAppMetadata().url,
      icons: [
        wcOptions?.appMetadata?.logoUrl || getDefaultAppMetadata().logoUrl,
      ],
    },
    rpcMap: rpcMap,
    qrModalOptions: wcOptions?.qrModalOptions,
    disableProviderPing: true,
  });

  provider.events.setMaxListeners(Infinity);

  // disconnect the provider if chains are stale when (if not auto connecting)
  if (!isAutoConnect) {
    const isStale = await isChainsStale(provider, chainsToRequest);

    if (isStale && provider.session) {
      await provider.disconnect();
    }
  }

  if (walletId !== "walletConnect") {
    function handleSessionRequest() {
      if (typeof window === "undefined") {
        return;
      }

      if (!isMobile()) {
        return;
      }

      const preferUniversal =
        walletInfo.mobile.universal || walletInfo.mobile.native;
      const preferNative =
        walletInfo.mobile.native || walletInfo.mobile.universal;

      if (isAndroid()) {
        if (preferUniversal) {
          openWindow(preferUniversal);
        }
      } else if (isIOS()) {
        if (preferNative) {
          openWindow(preferNative);
        }
      } else {
        if (preferUniversal) {
          openWindow(preferUniversal);
        }
      }
    }

    provider.signer.client.on("session_request_sent", handleSessionRequest);
    provider.events.addListener("disconnect", () => {
      provider.signer.client.off("session_request_sent", handleSessionRequest);
    });
  }

  return provider;
}

function onConnect(
  address: string,
  chain: Chain,
  provider: WCProvider,
  emitter: WalletEmitter<WCSupportedWalletIds>,
): [Account, Chain, DisconnectFn, SwitchChainFn] {
  const account: Account = {
    address,
    async sendTransaction(tx: SendTransactionOption) {
      const transactionHash = (await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            gas: tx.gas ? numberToHex(tx.gas) : undefined,
            value: tx.value ? numberToHex(tx.value) : undefined,
            from: this.address,
            to: tx.to as Address,
            data: tx.data,
          },
        ],
      })) as Hex;

      return {
        transactionHash,
      };
    },
    async signMessage({ message }) {
      return provider.request({
        method: "personal_sign",
        params: [message, this.address],
      });
    },
    async signTypedData(data) {
      const { domain, message, primaryType } =
        data as unknown as SignTypedDataParameters;

      const types = {
        EIP712Domain: getTypesForEIP712Domain({ domain }),
        ...data.types,
      };

      // Need to do a runtime validation check on addresses, byte ranges, integer ranges, etc
      // as we can't statically check this with TypeScript.
      validateTypedData({ domain, message, primaryType, types });

      const typedData = stringify(
        { domain: domain ?? {}, message, primaryType, types },
        (_, value) => (isHex(value) ? value.toLowerCase() : value),
      );

      return await provider.request({
        method: "eth_signTypedData_v4",
        params: [this.address, typedData],
      });
    },
  };

  function disconnect() {
    if (!provider) {
      return;
    }
    provider.disconnect();
    provider.removeListener("accountsChanged", onAccountsChanged);
    provider.removeListener("chainChanged", onChainChanged);
    provider.removeListener("disconnect", onDisconnect);
  }

  function onDisconnect() {
    setRequestedChainsIds([]);
    asyncLocalStorage?.removeItem(storageKeys.lastUsedChainId);
    disconnect();
    emitter.emit("disconnect", undefined);
  }

  function onAccountsChanged(accounts: string[]) {
    if (accounts[0]) {
      const newAccount: Account = {
        ...account,
        address: getAddress(accounts[0]),
      };
      emitter.emit("accountChanged", newAccount);
    } else {
      onDisconnect();
    }
  }

  function onChainChanged(newChainId: string) {
    const newChain = defineChain(normalizeChainId(newChainId));
    emitter.emit("chainChanged", newChain);
    asyncLocalStorage?.setItem(storageKeys.lastUsedChainId, String(newChainId));
  }

  provider.on("accountsChanged", onAccountsChanged);
  provider.on("chainChanged", onChainChanged);
  provider.on("disconnect", onDisconnect);
  provider.on("session_delete", onDisconnect);

  return [
    account,
    chain,
    disconnect,
    (newChain) => switchChainWC(provider, newChain),
  ];
}

// Storage utils  -----------------------------------------------------------------------------------------------

function getNamespaceMethods(provider: WCProvider) {
  return provider.session?.namespaces[NAMESPACE]?.methods || [];
}

function getNamespaceChainsIds(provider: WCProvider): number[] {
  if (!provider) {
    return [];
  }
  const chainIds = provider.session?.namespaces[NAMESPACE]?.chains?.map(
    (chain) => parseInt(chain.split(":")[1] || ""),
  );

  return chainIds ?? [];
}

async function switchChainWC(provider: WCProvider, chain: Chain) {
  const chainId = chain.id;
  try {
    const namespaceChains = getNamespaceChainsIds(provider);
    const namespaceMethods = getNamespaceMethods(provider);
    const isChainApproved = namespaceChains.includes(chainId);

    if (!isChainApproved && namespaceMethods.includes(ADD_ETH_CHAIN_METHOD)) {
      const apiChain = await getChainMetadata(chain);
      const firstExplorer = apiChain.explorers && apiChain.explorers[0];
      const blockExplorerUrls = firstExplorer
        ? { blockExplorerUrls: [firstExplorer.url] }
        : {};
      await provider.request({
        method: ADD_ETH_CHAIN_METHOD,
        params: [
          {
            chainId: numberToHex(apiChain.chainId),
            chainName: apiChain.name,
            nativeCurrency: apiChain.nativeCurrency,
            rpcUrls: getValidPublicRPCUrl(apiChain), // no clientId on purpose
            ...blockExplorerUrls,
          },
        ],
      });
      const requestedChains = await getRequestedChainsIds();
      requestedChains.push(chainId);
      setRequestedChainsIds(requestedChains);
    }
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: numberToHex(chainId) }],
    });
  } catch (error: any) {
    const message =
      typeof error === "string" ? error : (error as ProviderRpcError)?.message;
    if (/user rejected request/i.test(message)) {
      throw new UserRejectedRequestError(error);
    }

    throw new SwitchChainError(error);
  }
}

/**
 * if every chain requested were already requested earlier - then they are not stale
 * @param connectToChainId
 * @internal
 */
async function isChainsStale(provider: WCProvider, chains: number[]) {
  const namespaceMethods = getNamespaceMethods(provider);

  // if chain adding method is available, then chains are not stale
  if (namespaceMethods.includes(ADD_ETH_CHAIN_METHOD)) {
    return false;
  }

  // if new chains are considered stale, then return true
  if (!isNewChainsStale) {
    return false;
  }

  const requestedChains = await getRequestedChainsIds();
  const namespaceChains = getNamespaceChainsIds(provider);

  // if any of the requested chains are not in the namespace chains, then they are stale
  if (
    namespaceChains.length &&
    !namespaceChains.some((id) => chains.includes(id))
  ) {
    return false;
  }

  // if chain was requested earlier, then they are not stale
  return !chains.every((id) => requestedChains.includes(id));
}

/**
 * Set the requested chains to the storage.
 * @internal
 */
function setRequestedChainsIds(chains: number[]) {
  localStorage?.setItem(storageKeys.requestedChains, JSON.stringify(chains));
}

/**
 * Get the last requested chains from the storage.
 * @internal
 */
async function getRequestedChainsIds(): Promise<number[]> {
  const data = localStorage.getItem(storageKeys.requestedChains);
  return data ? JSON.parse(data) : [];
}

type ArrayOneOrMore<T> = {
  0: T;
} & Array<T>;

function getChainsToRequest(options: {
  chain?: Chain;
  optionalChains?: Chain[];
  client: ThirdwebClient;
}) {
  const rpcMap: Record<number, string> = {};

  if (options.chain) {
    rpcMap[options.chain.id] = getRpcUrlForChain({
      chain: options.chain,
      client: options.client,
    });
  }

  // limit optional chains to 10
  const optionalChains = (options?.optionalChains || []).slice(0, 10);

  optionalChains.forEach((chain) => {
    rpcMap[chain.id] = getRpcUrlForChain({
      chain: chain,
      client: options.client,
    });
  });

  const optionalChainIds = optionalChains.map((c) => c.id) || [];

  const chainsToRequest: ArrayOneOrMore<number> = options.chain
    ? [options.chain.id, ...optionalChainIds]
    : optionalChainIds.length > 0
      ? (optionalChainIds as ArrayOneOrMore<number>)
      : [1];

  return {
    rpcMap,
    chainsToRequest,
  };
}
