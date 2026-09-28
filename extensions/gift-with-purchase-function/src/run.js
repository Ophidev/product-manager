// @ts-check
import { DiscountApplicationStrategy } from "../generated/api";

/**
 * @typedef {import("../generated/api").RunInput} RunInput
 * @typedef {import("../generated/api").FunctionRunResult} FunctionRunResult
 * @typedef {import("../generated/api").CartLine} CartLine
 */

/**
 * @type {FunctionRunResult}
 */
const EMPTY_DISCOUNT = {
  discountApplicationStrategy: DiscountApplicationStrategy.All,
  discounts: [],
};

/**
 * Config persisted by the app on the discount's `$app:gift-with-purchase-function`
 * metafield, written by the /app/gift-with-purchase editor:
 * {
 *   title: string,
 *   conditionType: "QUANTITY" | "AMOUNT",
 *   buyProductIds: string[],
 *   tiers: Array<{
 *     requiredQuantity: number | null,
 *     requiredAmount: number | null,
 *     giftQuantity: number,
 *     giftProductIds: string[],
 *   }>,
 * }
 *
 * @param {RunInput} input
 * @returns {FunctionRunResult}
 */
export function run(input) {
  const configuration = JSON.parse(
    input?.discountNode?.metafield?.value ?? "{}",
  );

  const giftMessage = configuration.title || "Free gift";
  const tiers = Array.isArray(configuration.tiers) ? configuration.tiers : [];
  const appliesToAll = configuration.appliesToType === "ALL";
  const buyProductIds = new Set(configuration.buyProductIds ?? []);
  const lines = input.cart.lines;

  if (tiers.length === 0 || lines.length === 0 || (!appliesToAll && buyProductIds.size === 0)) {
    return EMPTY_DISCOUNT;
  }

  const productIdForLine = (line) =>
    line.merchandise.__typename === "ProductVariant"
      ? line.merchandise.product.id
      : null;

  // "Specific products"/"Specific collections" are both flattened into buyProductIds by the
  // app before saving; "All products" (appliesToType === "ALL") skips that filter entirely.
  const qualifyingLines = appliesToAll
    ? lines
    : lines.filter((line) => buyProductIds.has(productIdForLine(line)));

  const totalQuantity = qualifyingLines.reduce(
    (sum, line) => sum + line.quantity,
    0,
  );
  const totalAmount = qualifyingLines.reduce(
    (sum, line) => sum + Number(line.cost.subtotalAmount.amount),
    0,
  );

  const meetsCondition = (tier) =>
    configuration.conditionType === "AMOUNT"
      ? tier.requiredAmount != null && totalAmount >= Number(tier.requiredAmount)
      : tier.requiredQuantity != null && totalQuantity >= Number(tier.requiredQuantity);

  const discounts = [];

  for (const tier of tiers) {
    if (!meetsCondition(tier)) continue;

    const giftProductIds = new Set(tier.giftProductIds ?? []);
    let remaining = Number(tier.giftQuantity ?? 0);
    if (giftProductIds.size === 0 || remaining <= 0) continue;

    for (const line of lines) {
      if (remaining <= 0) break;
      if (!giftProductIds.has(productIdForLine(line))) continue;

      const quantity = Math.min(remaining, line.quantity);
      if (quantity <= 0) continue;

      discounts.push({
        message: giftMessage,
        targets: [{ cartLine: { id: line.id, quantity } }],
        value: { percentage: { value: "100.0" } },
      });
      remaining -= quantity;
    }
  }

  if (discounts.length === 0) {
    return EMPTY_DISCOUNT;
  }

  return {
    discountApplicationStrategy: DiscountApplicationStrategy.All,
    discounts,
  };
}
