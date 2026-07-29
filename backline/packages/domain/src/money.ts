/**
 * Money as integer minor units plus an explicit currency.
 *
 * simple-salesforce threads an injectable `parse_float` through every response
 * precisely so callers can keep Decimal semantics (api.py:59-61). We avoid the
 * problem instead of parameterising it: floats never represent money here.
 */

import { ValidationError } from "./errors.js";

export interface Money {
  /** Amount in minor units (cents, pence). Always an integer. */
  readonly minor: bigint;
  /** ISO 4217. */
  readonly currency: string;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function money(minor: bigint | number, currency: string): Money {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new ValidationError(`Invalid ISO 4217 currency: ${currency}`);
  }
  if (typeof minor === "number" && !Number.isInteger(minor)) {
    throw new ValidationError(
      `Money must be integer minor units, received ${minor}. ` +
        `Multiply by the currency exponent before constructing.`,
    );
  }
  return { minor: BigInt(minor), currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new ValidationError(
      `Cannot combine ${a.currency} and ${b.currency} without an explicit FX conversion. ` +
        `Convert through the settlement's fx_snapshot first.`,
    );
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minor: a.minor + b.minor, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minor: a.minor - b.minor, currency: a.currency };
}

export function sumMoney(amounts: readonly Money[], currency: string): Money {
  return amounts.reduce<Money>((acc, next) => addMoney(acc, next), money(0n, currency));
}

/** Basis points, rounded half-up, staying in integer space throughout. */
export function applyBasisPoints(amount: Money, bps: number): Money {
  if (!Number.isInteger(bps) || bps < 0) {
    throw new ValidationError(`Basis points must be a non-negative integer, received ${bps}.`);
  }
  const numerator = amount.minor * BigInt(bps);
  const rounded = (numerator + 5000n) / 10000n;
  return { minor: rounded, currency: amount.currency };
}

export function formatMoney(amount: Money, exponent = 2): string {
  const divisor = 10n ** BigInt(exponent);
  const whole = amount.minor / divisor;
  const fraction = (amount.minor < 0n ? -amount.minor : amount.minor) % divisor;
  return `${whole}.${fraction.toString().padStart(exponent, "0")} ${amount.currency}`;
}
