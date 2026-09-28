import { authenticate } from "../shopify.server";

// eslint-disable-next-line no-undef
const isOurApp = (appDiscountType) => appDiscountType?.appKey === process.env.SHOPIFY_API_KEY;

// Public app-proxy endpoint: called directly by the storefront (gwp-auto-gift.js), signed and
// forwarded by Shopify, so `authenticate.public.appProxy` verifies the request and resolves an
// authenticated admin client for the requesting shop.
export const loader = async ({ request }) => {
    const url = new URL(request.url);
    const debug = url.searchParams.get("debug") === "1";

    try {
    const { admin } = await authenticate.public.appProxy(request);

    if (!admin) {
        return Response.json(debug ? { error: "no admin session resolved" } : []);
    }

    const response = await admin.graphql(`
        #graphql
        query GetActiveGwpDiscounts {
            discountNodes(first: 50) {
                nodes {
                    id
                    metafield(namespace: "$app:gift-with-purchase-function", key: "function-configuration") {
                        value
                    }
                    discount {
                        __typename
                        ... on DiscountAutomaticApp {
                            status
                            appDiscountType { appKey }
                        }
                    }
                }
            }
        }
    `);
    const data = (await response.json()).data;

    if (debug) {
        return Response.json(
            data.discountNodes.nodes.map((node) => ({
                id: node.id,
                typename: node.discount?.__typename,
                status: node.discount?.status,
                appKey: node.discount?.appDiscountType?.appKey,
                ourAppKey: process.env.SHOPIFY_API_KEY, // eslint-disable-line no-undef
                hasMetafield: Boolean(node.metafield?.value),
                configPreview: node.metafield?.value ? JSON.parse(node.metafield.value) : null,
            })),
        );
    }

    const rules = data.discountNodes.nodes
        .filter((node) =>
            node.discount?.__typename === "DiscountAutomaticApp" &&
            node.discount.status === "ACTIVE" &&
            isOurApp(node.discount.appDiscountType) &&
            node.metafield?.value,
        )
        .map((node) => {
            let config;
            try {
                config = JSON.parse(node.metafield.value);
            } catch {
                return null;
            }
            if (config.giftAddMode !== "AUTOMATIC" || !Array.isArray(config.tiers)) return null;

            return {
                discountId: node.id,
                appliesToType: config.appliesToType ?? "PRODUCTS",
                conditionType: config.conditionType ?? "QUANTITY",
                buyProductIds: config.buyProductIds ?? [],
                tiers: config.tiers.map((tier) => ({
                    requiredQuantity: tier.requiredQuantity ?? null,
                    requiredAmount: tier.requiredAmount ?? null,
                    giftQuantity: tier.giftQuantity ?? 0,
                    giftVariantId: tier.giftVariantIds?.[0] ?? null,
                })),
            };
        })
        .filter(Boolean);

    return Response.json(rules, {
        headers: { "Cache-Control": "public, max-age=30" },
    });
    } catch (error) {
        console.error("gwp config endpoint failed", error);
        // The App Proxy replaces any non-200 response with a generic themed error page and
        // discards the body, so this must always return 200 to see the real error via ?debug=1.
        return Response.json(
            debug ? { error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null } : [],
        );
    }
};
