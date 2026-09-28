-- CreateTable
CREATE TABLE "GiftWithPurchase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyDiscountId" TEXT NOT NULL,
    "discountMethod" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "GiftWithPurchase_shop_shopifyDiscountId_key" ON "GiftWithPurchase"("shop", "shopifyDiscountId");
