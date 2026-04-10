
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(
  typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url),
);
const sdk = require('@pump-fun/pump-sdk');

export const OnlinePumpSdk = sdk.OnlinePumpSdk;
export const PumpSdk = sdk.PumpSdk;
export const PUMP_SDK = sdk.PUMP_SDK;
export const getBuyTokenAmountFromSolAmount = sdk.getBuyTokenAmountFromSolAmount;
export const getSellSolAmountFromTokenAmount = sdk.getSellSolAmountFromTokenAmount;
export const bondingCurvePda = sdk.bondingCurvePda;
export const bondingCurveMarketCap = sdk.bondingCurveMarketCap;
export const bondingCurveV2Pda = sdk.bondingCurveV2Pda;
export const canonicalPumpPoolPda = sdk.canonicalPumpPoolPda;
export const feeSharingConfigPda = sdk.feeSharingConfigPda;
export const getPumpProgram = sdk.getPumpProgram;
export const getPumpAmmProgram = sdk.getPumpAmmProgram;
export const getPumpFeeProgram = sdk.getPumpFeeProgram;
export const newBondingCurve = sdk.newBondingCurve;

export type { BondingCurve, Global, FeeConfig } from '@pump-fun/pump-sdk';
