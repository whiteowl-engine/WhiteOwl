
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import bs58 from 'bs58';
import * as fs from 'fs';
import * as path from 'path';
import { LoggerInterface } from '../types.ts';

const { Permissions, Permission } = multisig.types;

function allPerms() {
  return Permissions.fromPermissions([Permission.Initiate, Permission.Vote, Permission.Execute]);
}

interface StoredMultisig {
  name: string;
  multisigPda: string;
  vault: string;
  threshold: number;
  members: string[];
  createdBy: string;
  createdAt: number;
}

interface MultisigStore {
  multisigs: StoredMultisig[];
}

const STORE_FILE = path.join('./data', 'multisigs.json');

function loadStore(): MultisigStore {
  try {
    if (fs.existsSync(STORE_FILE)) return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
  } catch {}
  return { multisigs: [] };
}

function saveStore(store: MultisigStore) {
  const dir = path.dirname(STORE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

function statusLabel(status: any): string {
  if (multisig.types.isProposalStatusActive(status))    return 'Active (voting)';
  if (multisig.types.isProposalStatusApproved(status))  return 'Approved (ready to execute)';
  if (multisig.types.isProposalStatusRejected(status))  return 'Rejected';
  if (multisig.types.isProposalStatusCancelled(status)) return 'Cancelled';
  if (multisig.types.isProposalStatusExecuted(status))  return 'Executed';
  return 'Draft';
}

export class SquadsMultisig {
  private conn: Connection;
  private logger: LoggerInterface;
  private walletKeypair: Keypair | null;

  constructor(rpcUrl: string, logger: LoggerInterface, walletKeypair: Keypair | null) {
    this.conn = new Connection(rpcUrl, 'confirmed');
    this.logger = logger;
    this.walletKeypair = walletKeypair;
  }

  setKeypair(kp: Keypair | null) {
    this.walletKeypair = kp;
  }

  private requireKeypair(): Keypair {
    if (!this.walletKeypair) throw new Error('No wallet configured. Import or generate a wallet first.');
    return this.walletKeypair;
  }

  async createMultisig(name: string, memberKeys: string[], threshold: number): Promise<{
    multisigPda: string;
    vault: string;
    txSignature: string;
  }> {
    const creator = this.requireKeypair();

    const allKeys = Array.from(new Set([creator.publicKey.toBase58(), ...memberKeys]));

    if (threshold < 1 || threshold > allKeys.length) {
      throw new Error(`Threshold must be between 1 and ${allKeys.length} (number of members).`);
    }


    const createKey = Keypair.generate();

    const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });
    const [vaultPda]    = multisig.getVaultPda({ multisigPda, index: 0 });


    const [programConfigPda] = multisig.getProgramConfigPda({});
    const programConfigAccount = await this.conn.getAccountInfo(programConfigPda);
    if (!programConfigAccount) throw new Error('Cannot reach Squads program config. Check your RPC endpoint.');
    const programConfig = multisig.accounts.ProgramConfig.fromAccountInfo(programConfigAccount)[0];
    const treasury = programConfig.treasury;

    const members = allKeys.map(k => ({
      key: new PublicKey(k),
      permissions: allPerms(),
    }));


    const balance = await this.conn.getBalance(creator.publicKey);

    const estimatedSize = 8 + 32 + 32 + 2 + 4 + 8 + 8 + 34 + 1 + 4 + (allKeys.length * 33) + 64;
    const rentNeeded = await this.conn.getMinimumBalanceForRentExemption(estimatedSize);
    const totalNeeded = rentNeeded + 10_000;
    if (balance < totalNeeded) {
      const deficit = ((totalNeeded - balance) / LAMPORTS_PER_SOL).toFixed(4);
      throw new Error(
        `Insufficient SOL for multisig creation. Need ~${(totalNeeded / LAMPORTS_PER_SOL).toFixed(4)} SOL for rent, ` +
        `but wallet has ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL. Please fund the wallet with at least ${deficit} more SOL.`
      );
    }

    this.logger.info(`[Multisig] Creating ${threshold}-of-${allKeys.length} multisig "${name}"...`);

    const txSig = await multisig.rpc.multisigCreateV2({
      connection: this.conn,
      treasury,
      createKey,
      creator,
      multisigPda,
      configAuthority: null,
      threshold,
      members,
      timeLock: 0,
      rentCollector: null,
      memo: name,
    });


    const store = loadStore();
    store.multisigs.push({
      name,
      multisigPda: multisigPda.toBase58(),
      vault: vaultPda.toBase58(),
      threshold,
      members: allKeys,
      createdBy: creator.publicKey.toBase58(),
      createdAt: Date.now(),
    });
    saveStore(store);

    this.logger.info(`[Multisig] Created! Vault address: ${vaultPda.toBase58()}`);

    return {
      multisigPda: multisigPda.toBase58(),
      vault: vaultPda.toBase58(),
      txSignature: txSig,
    };
  }


async getMultisigInfo(multisigPdaStr: string): Promise<{
    name: string;
    vault: string;
    threshold: number;
    memberCount: number;
    members: string[];
    transactionCount: number;
    vaultBalanceSol: number;
  }> {
    const multisigPda = new PublicKey(multisigPdaStr);
    const [vaultPda]  = multisig.getVaultPda({ multisigPda, index: 0 });

    const accountInfo = await this.conn.getAccountInfo(multisigPda);
    if (!accountInfo) throw new Error(`Multisig account not found: ${multisigPdaStr}`);

    const ms = multisig.accounts.Multisig.fromAccountInfo(accountInfo)[0];
    const vaultBalance = await this.conn.getBalance(vaultPda);

    const local = loadStore().multisigs.find(m => m.multisigPda === multisigPdaStr);

    return {
      name: local?.name ?? 'Unknown',
      vault: vaultPda.toBase58(),
      threshold: ms.threshold,
      memberCount: ms.members.length,
      members: ms.members.map(m => m.key.toBase58()),
      transactionCount: Number(ms.transactionIndex),
      vaultBalanceSol: vaultBalance / LAMPORTS_PER_SOL,
    };
  }


async proposeTransfer(multisigPdaStr: string, toAddress: string, amountSol: number, memo?: string): Promise<{
    txIndex: number;
    proposalSignature: string;
  }> {
    const member = this.requireKeypair();
    const multisigPda = new PublicKey(multisigPdaStr);
    const [vaultPda]  = multisig.getVaultPda({ multisigPda, index: 0 });


    const accountInfo = await this.conn.getAccountInfo(multisigPda);
    if (!accountInfo) throw new Error(`Multisig not found: ${multisigPdaStr}`);
    const ms = multisig.accounts.Multisig.fromAccountInfo(accountInfo)[0];
    const txIndex = BigInt(Number(ms.transactionIndex) + 1);

    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const { blockhash } = await this.conn.getLatestBlockhash();


    const transferIx = SystemProgram.transfer({
      fromPubkey: vaultPda,
      toPubkey:   new PublicKey(toAddress),
      lamports,
    });

    const txMessage = new TransactionMessage({
      payerKey:        vaultPda,
      recentBlockhash: blockhash,
      instructions:    [transferIx],
    });

    this.logger.info(`[Multisig] Proposing transfer of ${amountSol} SOL → ${toAddress} (txIndex=${txIndex})`);


    await multisig.rpc.vaultTransactionCreate({
      connection:         this.conn,
      feePayer:           member,
      multisigPda,
      transactionIndex:   txIndex,
      creator:            member.publicKey,
      vaultIndex:         0,
      ephemeralSigners:   0,
      transactionMessage: txMessage,
      memo,
    });


    const propSig = await multisig.rpc.proposalCreate({
      connection:       this.conn,
      feePayer:         member,
      creator:          member,
      multisigPda,
      transactionIndex: txIndex,
      isDraft:          false,
    });

    this.logger.info(`[Multisig] Proposal created (index ${txIndex}), members can now vote.`);

    return { txIndex: Number(txIndex), proposalSignature: propSig };
  }


async approveProposal(multisigPdaStr: string, txIndex: number): Promise<string> {
    const member = this.requireKeypair();
    const multisigPda = new PublicKey(multisigPdaStr);

    const sig = await multisig.rpc.proposalApprove({
      connection:       this.conn,
      feePayer:         member,
      member,
      multisigPda,
      transactionIndex: BigInt(txIndex),
    });

    this.logger.info(`[Multisig] Approved proposal #${txIndex}`);
    return sig;
  }

async rejectProposal(multisigPdaStr: string, txIndex: number): Promise<string> {
    const member = this.requireKeypair();
    const multisigPda = new PublicKey(multisigPdaStr);

    const sig = await multisig.rpc.proposalReject({
      connection:       this.conn,
      feePayer:         member,
      member,
      multisigPda,
      transactionIndex: BigInt(txIndex),
    });

    this.logger.info(`[Multisig] Rejected proposal #${txIndex}`);
    return sig;
  }


async executeProposal(multisigPdaStr: string, txIndex: number): Promise<string> {
    const member = this.requireKeypair();
    const multisigPda = new PublicKey(multisigPdaStr);

    const sig = await multisig.rpc.vaultTransactionExecute({
      connection:       this.conn,
      feePayer:         member,
      multisigPda,
      transactionIndex: BigInt(txIndex),
      member:           member.publicKey,
    });

    this.logger.info(`[Multisig] Executed proposal #${txIndex}: ${sig}`);
    return sig;
  }


async listProposals(multisigPdaStr: string): Promise<Array<{
    index: number;
    status: string;
    approved: number;
    rejected: number;
    cancelled: number;
    approvedBy: string[];
    rejectedBy: string[];
  }>> {
    const multisigPda = new PublicKey(multisigPdaStr);

    const accountInfo = await this.conn.getAccountInfo(multisigPda);
    if (!accountInfo) throw new Error(`Multisig not found: ${multisigPdaStr}`);
    const ms = multisig.accounts.Multisig.fromAccountInfo(accountInfo)[0];

    const totalTx = Number(ms.transactionIndex);
    if (totalTx === 0) return [];

    const results = [];

    for (let i = 1; i <= totalTx; i++) {
      try {
        const [proposalPda] = multisig.getProposalPda({ multisigPda, transactionIndex: BigInt(i) });
        const propInfo = await this.conn.getAccountInfo(proposalPda);
        if (!propInfo) continue;

        const proposal = multisig.accounts.Proposal.fromAccountInfo(propInfo)[0];

        results.push({
          index:      i,
          status:     statusLabel(proposal.status),
          approved:   proposal.approved.length,
          rejected:   proposal.rejected.length,
          cancelled:  proposal.cancelled.length,
          approvedBy: proposal.approved.map(k => k.toBase58()),
          rejectedBy: proposal.rejected.map(k => k.toBase58()),
        });
      } catch {

      }
    }

    return results;
  }


getStoredMultisigs(): StoredMultisig[] {
    return loadStore().multisigs;
  }

async importMultisig(multisigPdaStr: string, name: string): Promise<StoredMultisig> {
    const info = await this.getMultisigInfo(multisigPdaStr);
    const entry: StoredMultisig = {
      name,
      multisigPda: multisigPdaStr,
      vault: info.vault,
      threshold: info.threshold,
      members: info.members,
      createdBy: 'imported',
      createdAt: Date.now(),
    };

    const store = loadStore();
    if (!store.multisigs.find(m => m.multisigPda === multisigPdaStr)) {
      store.multisigs.push(entry);
      saveStore(store);
    }

    return entry;
  }

removeFromStore(multisigPdaStr: string): boolean {
    const store = loadStore();
    const before = store.multisigs.length;
    store.multisigs = store.multisigs.filter(m => m.multisigPda !== multisigPdaStr);
    if (store.multisigs.length < before) { saveStore(store); return true; }
    return false;
  }

static getVaultAddress(multisigPdaStr: string): string {
    const [vaultPda] = multisig.getVaultPda({ multisigPda: new PublicKey(multisigPdaStr), index: 0 });
    return vaultPda.toBase58();
  }


private loadLocalMemberKeypairs(memberPubkeys: string[]): Keypair[] {
    const WALLETS_FILE = path.join('./data', 'wallets.json');
    let walletStore: { wallets: { address: string; privateKey: string }[] };
    try {
      walletStore = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    } catch { return []; }
    const memberSet = new Set(memberPubkeys);
    const keypairs: Keypair[] = [];
    for (const w of walletStore.wallets || []) {
      if (memberSet.has(w.address)) {
        try {
          keypairs.push(Keypair.fromSecretKey(bs58.decode(w.privateKey)));
        } catch {}
      }
    }
    return keypairs;
  }

async sendFromVault(multisigPdaStr: string, toAddress: string, amountSol: number, memo?: string): Promise<{
    signature: string;
    txIndex: number;
  }> {
    const multisigPda = new PublicKey(multisigPdaStr);
    const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });


    const msAccount = await multisig.accounts.Multisig.fromAccountAddress(this.conn, multisigPda);
    const threshold = msAccount.threshold;
    const onChainMembers = msAccount.members.map((m: any) => m.key.toBase58());


    const localKeypairs = this.loadLocalMemberKeypairs(onChainMembers);
    if (localKeypairs.length < threshold) {
      throw new Error(
        `Need ${threshold} local member keys to send, but only ${localKeypairs.length} found locally. ` +
        `Use the proposal workflow instead.`
      );
    }


    const currentIndex = BigInt(msAccount.transactionIndex.toString());
    const txIndex = currentIndex + 1n;
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

    this.logger.info(`[Vault] Direct send ${amountSol} SOL → ${toAddress} (txIndex=${txIndex}, auto ${localKeypairs.length}/${threshold} sigs)`);


    const feePayer = localKeypairs[0];


    const { blockhash } = await this.conn.getLatestBlockhash();
    const transferIx = SystemProgram.transfer({
      fromPubkey: vaultPda,
      toPubkey: new PublicKey(toAddress),
      lamports,
    });
    const txMessage = new TransactionMessage({
      payerKey: vaultPda,
      recentBlockhash: blockhash,
      instructions: [transferIx],
    });


    const vtSig = await multisig.rpc.vaultTransactionCreate({
      connection: this.conn,
      feePayer,
      multisigPda,
      transactionIndex: txIndex,
      creator: feePayer.publicKey,
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: txMessage,
      memo,
    });
    this.logger.info(`[Vault] Step 1/4 vaultTransactionCreate: ${vtSig}`);
    await this.conn.confirmTransaction(vtSig, 'confirmed');


    const propSig = await multisig.rpc.proposalCreate({
      connection: this.conn,
      feePayer,
      creator: feePayer,
      multisigPda,
      transactionIndex: txIndex,
      isDraft: false,
    });
    this.logger.info(`[Vault] Step 2/4 proposalCreate: ${propSig}`);
    await this.conn.confirmTransaction(propSig, 'confirmed');


    for (let i = 0; i < threshold; i++) {
      const member = localKeypairs[i];
      const appSig = await multisig.rpc.proposalApprove({
        connection: this.conn,
        feePayer: localKeypairs[0],
        member,
        multisigPda,
        transactionIndex: txIndex,
      });
      this.logger.info(`[Vault] Step 3/4 proposalApprove[${i}]: ${appSig}`);
      await this.conn.confirmTransaction(appSig, 'confirmed');
    }


    const sig = await multisig.rpc.vaultTransactionExecute({
      connection: this.conn,
      feePayer: localKeypairs[0],
      multisigPda,
      transactionIndex: txIndex,
      member: localKeypairs[0].publicKey,
    });
    this.logger.info(`[Vault] Step 4/4 vaultTransactionExecute: ${sig}`);

    this.logger.info(`[Vault] Sent! tx=${sig}`);
    return { signature: sig, txIndex: Number(txIndex) };
  }

async getVaultBalance(multisigPdaStr: string): Promise<number> {
    const multisigPda = new PublicKey(multisigPdaStr);
    const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });
    const lamports = await this.conn.getBalance(vaultPda);
    return lamports / LAMPORTS_PER_SOL;
  }

getLocalKeyCount(multisigPdaStr: string): { localKeys: number; threshold: number; members: string[] } {
    const stored = loadStore().multisigs.find(m => m.multisigPda === multisigPdaStr);
    if (!stored) return { localKeys: 0, threshold: 0, members: [] };
    const localKeypairs = this.loadLocalMemberKeypairs(stored.members);
    return { localKeys: localKeypairs.length, threshold: stored.threshold, members: stored.members };
  }

checkMembers(memberKeys: string[]): { local: string[]; external: string[]; allLocal: boolean } {
    const WALLETS_FILE = path.join('./data', 'wallets.json');
    let walletStore: { wallets: { address: string }[] };
    try {
      walletStore = JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf-8'));
    } catch { return { local: [], external: memberKeys, allLocal: false }; }
    const localAddrs = new Set((walletStore.wallets || []).map(w => w.address));
    const local: string[] = [];
    const external: string[] = [];
    for (const k of memberKeys) {
      if (localAddrs.has(k)) local.push(k);
      else external.push(k);
    }
    return { local, external, allLocal: external.length === 0 };
  }

async smartSendFromVault(multisigPdaStr: string, toAddress: string, amountSol: number, memo?: string): Promise<{
    signature?: string;
    txIndex: number;
    status: 'executed' | 'pending';
    approvalsNeeded: number;
    approvalsHave: number;
  }> {
    const multisigPda = new PublicKey(multisigPdaStr);
    const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

    const msAccount = await multisig.accounts.Multisig.fromAccountAddress(this.conn, multisigPda);
    const threshold = msAccount.threshold;
    const onChainMembers = msAccount.members.map((m: any) => m.key.toBase58());

    const localKeypairs = this.loadLocalMemberKeypairs(onChainMembers);
    const canAutoExecute = localKeypairs.length >= threshold;

    const currentIndex = BigInt(msAccount.transactionIndex.toString());
    const txIndex = currentIndex + 1n;
    const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
    const feePayer = localKeypairs[0];
    if (!feePayer) throw new Error('No local member keys found. Cannot create transactions.');

    this.logger.info(`[Vault] Smart send ${amountSol} SOL → ${toAddress} (local=${localKeypairs.length}/${threshold})`);


    const { blockhash } = await this.conn.getLatestBlockhash();
    const transferIx = SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: new PublicKey(toAddress), lamports });
    const txMessage = new TransactionMessage({ payerKey: vaultPda, recentBlockhash: blockhash, instructions: [transferIx] });


    const vtSig = await multisig.rpc.vaultTransactionCreate({
      connection: this.conn, feePayer, multisigPda, transactionIndex: txIndex,
      creator: feePayer.publicKey, vaultIndex: 0, ephemeralSigners: 0, transactionMessage: txMessage, memo,
    });
    this.logger.info(`[Vault] Step 1 vaultTransactionCreate: ${vtSig}`);
    await this.conn.confirmTransaction(vtSig, 'confirmed');


    const propSig = await multisig.rpc.proposalCreate({
      connection: this.conn, feePayer, creator: feePayer, multisigPda, transactionIndex: txIndex, isDraft: false,
    });
    this.logger.info(`[Vault] Step 2 proposalCreate: ${propSig}`);
    await this.conn.confirmTransaction(propSig, 'confirmed');


    const approvalCount = Math.min(localKeypairs.length, threshold);
    for (let i = 0; i < approvalCount; i++) {
      const appSig = await multisig.rpc.proposalApprove({
        connection: this.conn, feePayer: localKeypairs[0], member: localKeypairs[i], multisigPda, transactionIndex: txIndex,
      });
      this.logger.info(`[Vault] Step 3 proposalApprove[${i}]: ${appSig}`);
      await this.conn.confirmTransaction(appSig, 'confirmed');
    }


    if (canAutoExecute) {
      const sig = await multisig.rpc.vaultTransactionExecute({
        connection: this.conn, feePayer: localKeypairs[0], multisigPda, transactionIndex: txIndex, member: localKeypairs[0].publicKey,
      });
      this.logger.info(`[Vault] Step 4 vaultTransactionExecute: ${sig}`);
      return { signature: sig, txIndex: Number(txIndex), status: 'executed', approvalsNeeded: threshold, approvalsHave: approvalCount };
    }


    this.logger.info(`[Vault] Pending: ${approvalCount}/${threshold} approvals. Waiting for external signers.`);
    return { txIndex: Number(txIndex), status: 'pending', approvalsNeeded: threshold, approvalsHave: approvalCount };
  }
}
