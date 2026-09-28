import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { useLanguage } from "../context/LanguageContext";
import { format } from "../context/languageData";
import db from "../db.server";

const METAFIELD_NAMESPACE = "$app:gift-with-purchase-function";
const METAFIELD_KEY = "function-configuration";
const MAX_TIERS = 10;

const emptyTier = () => ({
    requiredQuantity: "",
    requiredAmount: "",
    giftQuantity: "1",
    giftProducts: [],
});

// loader -- read/get data
export const loader = async ({ request, params }) => {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;
    const isNew = params.id === "new";

    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim();
    const resource = url.searchParams.get("resource") === "collection" ? "collection" : "product";
    let searchedProducts = [];
    let searchedCollections = [];
    if (query && resource === "product") {
        const response = await admin.graphql(`
            #graphql
            query SearchProductsForGiftWithPurchase($query: String!) {
                products(first: 10, query: $query) {
                    nodes {
                        id
                        title
                        featuredImage { url }
                    }
                }
            }
        `, { variables: { query: `title:*${query}*` } });
        searchedProducts = (await response.json()).data.products.nodes;
    } else if (query && resource === "collection") {
        const response = await admin.graphql(`
            #graphql
            query SearchCollectionsForGiftWithPurchase($query: String!) {
                collections(first: 10, query: $query) {
                    nodes {
                        id
                        title
                        image { url }
                    }
                }
            }
        `, { variables: { query: `title:*${query}*` } });
        searchedCollections = (await response.json()).data.collections.nodes;
    }

    if (isNew) {
        return { isNew: true, discount: null, products: searchedProducts, collections: searchedCollections };
    }

    // The route param is the discount's legacy numeric id; the underlying discount can be
    // either an automatic or a code discount, so we try both node types.
    const numericId = params.id.toString().split("/").pop();
    const automaticGid = `gid://shopify/DiscountAutomaticNode/${numericId}`;
    const codeGid = `gid://shopify/DiscountCodeNode/${numericId}`;

    const response = await admin.graphql(`
        #graphql
        query GetGiftWithPurchaseForEdit($automaticId: ID!, $codeId: ID!, $namespace: String!, $key: String!) {
            automaticNode: discountNode(id: $automaticId) {
                id
                metafield(namespace: $namespace, key: $key) { value }
                discount {
                    __typename
                    ... on DiscountAutomaticApp {
                        title
                        startsAt
                        endsAt
                        combinesWith { productDiscounts orderDiscounts shippingDiscounts }
                        appDiscountType { functionId }
                    }
                }
            }
            codeNode: discountNode(id: $codeId) {
                id
                metafield(namespace: $namespace, key: $key) { value }
                discount {
                    __typename
                    ... on DiscountCodeApp {
                        title
                        startsAt
                        endsAt
                        combinesWith { productDiscounts orderDiscounts shippingDiscounts }
                        appDiscountType { functionId }
                        codes(first: 1) { nodes { code } }
                    }
                }
            }
        }
    `, {
        variables: { automaticId: automaticGid, codeId: codeGid, namespace: METAFIELD_NAMESPACE, key: METAFIELD_KEY },
    });

    const data = (await response.json()).data;
    const automaticNode = data.automaticNode;
    const codeNode = data.codeNode;

    const isAutomatic = automaticNode?.discount?.__typename === "DiscountAutomaticApp";
    const isCode = codeNode?.discount?.__typename === "DiscountCodeApp";

    if (!isAutomatic && !isCode) {
        throw new Response("Discount not found", { status: 404 });
    }

    const nodeId = isAutomatic ? automaticNode.id : codeNode.id;
    const discountFields = isAutomatic ? automaticNode.discount : codeNode.discount;
    const metafieldValue = isAutomatic ? automaticNode.metafield?.value : codeNode.metafield?.value;

    // Security: confirm this discount belongs to *our* function before trusting its config.
    // authenticate.admin() already scopes `admin` to the current shop, and Shopify's discount
    // GraphQL only ever returns resources that belong to that shop, so a mismatched shop id
    // simply won't resolve above (404). This check additionally guards against the id
    // resolving to some other app's app-discount.
    const config = metafieldValue ? JSON.parse(metafieldValue) : null;
    if (!discountFields.appDiscountType?.functionId || config == null) {
        throw new Response("Not a Gift with purchase discount", { status: 404 });
    }

    const appliesToType = config.appliesToType ?? "PRODUCTS";

    let buyProducts = [];
    if (appliesToType === "PRODUCTS" && config.buyProductIds?.length) {
        const buyResponse = await admin.graphql(`
            #graphql
            query GetBuyProducts($ids: [ID!]!) {
                nodes(ids: $ids) {
                    ... on Product { id title featuredImage { url } }
                }
            }
        `, { variables: { ids: config.buyProductIds } });
        buyProducts = ((await buyResponse.json()).data.nodes ?? []).filter(Boolean);
    }

    let buyCollections = [];
    if (appliesToType === "COLLECTIONS" && config.buyCollectionIds?.length) {
        const collResponse = await admin.graphql(`
            #graphql
            query GetBuyCollections($ids: [ID!]!) {
                nodes(ids: $ids) {
                    ... on Collection { id title image { url } }
                }
            }
        `, { variables: { ids: config.buyCollectionIds } });
        buyCollections = ((await collResponse.json()).data.nodes ?? []).filter(Boolean);
    }

    const allGiftProductIds = [...new Set((config.tiers ?? []).flatMap((tier) => tier.giftProductIds ?? []))];
    let giftProductsById = {};
    if (allGiftProductIds.length) {
        const giftResponse = await admin.graphql(`
            #graphql
            query GetGiftProducts($ids: [ID!]!) {
                nodes(ids: $ids) {
                    ... on Product { id title featuredImage { url } }
                }
            }
        `, { variables: { ids: allGiftProductIds } });
        for (const node of (await giftResponse.json()).data.nodes ?? []) {
            if (node) giftProductsById[node.id] = node;
        }
    }

    const discount = {
        id: nodeId,
        numericId,
        shop,
        discountMethod: isAutomatic ? "AUTOMATIC" : "CODE",
        code: isCode ? (discountFields.codes.nodes[0]?.code ?? "") : "",
        title: discountFields.title,
        startsAt: discountFields.startsAt,
        endsAt: discountFields.endsAt,
        combinesWith: discountFields.combinesWith,
        conditionType: config.conditionType ?? "QUANTITY",
        giftAddMode: config.giftAddMode ?? "MANUAL",
        appliesToType,
        buyProducts,
        buyCollections,
        purchaseType: config.purchaseType ?? "BOTH",
        excludeCompareAtPrices: Boolean(config.excludeCompareAtPrices),
        selectionStrategy: config.selectionStrategy ?? "WIDGET_ONLY",
        tiers: (config.tiers ?? []).map((tier) => ({
            requiredQuantity: tier.requiredQuantity != null ? String(tier.requiredQuantity) : "",
            requiredAmount: tier.requiredAmount != null ? String(tier.requiredAmount) : "",
            giftQuantity: String(tier.giftQuantity ?? 1),
            giftProducts: (tier.giftProductIds ?? []).map((id) => giftProductsById[id]).filter(Boolean),
        })),
    };

    // Self-healing: keep our shop-scoped index in sync even if this discount was created
    // directly in Shopify Admin, or predates this feature.
    await db.giftWithPurchase.upsert({
        where: { shop_shopifyDiscountId: { shop, shopifyDiscountId: nodeId } },
        update: { discountMethod: discount.discountMethod },
        create: { shop, shopifyDiscountId: nodeId, discountMethod: discount.discountMethod },
    });

    return { isNew: false, discount, products: searchedProducts, collections: searchedCollections };
};

// action -- write/update
export const action = async ({ request, params }) => {
    const { admin, session } = await authenticate.admin(request);
    const shop = session.shop;
    const isNew = params.id === "new";

    const formData = await request.formData();
    const discountMethod = (formData.get("discountMethod") || "AUTOMATIC").toString();
    const code = (formData.get("code") || "").toString().trim();
    const title = (formData.get("title") || "").toString().trim();
    const conditionType = (formData.get("conditionType") || "QUANTITY").toString();
    const purchaseType = (formData.get("purchaseType") || "BOTH").toString();
    const excludeCompareAtPrices = formData.get("excludeCompareAtPrices") === "true";
    const selectionStrategy = discountMethod === "CODE" ? "ANY_MATCHING" : (formData.get("selectionStrategy") || "WIDGET_ONLY").toString();
    const giftAddMode = (formData.get("giftAddMode") || "MANUAL").toString();
    const startsAt = (formData.get("startsAt") || "").toString();
    const hasEndDate = formData.get("hasEndDate") === "true";
    const endsAt = hasEndDate ? (formData.get("endsAt") || "").toString() : null;

    const appliesToType = (formData.get("appliesToType") || "PRODUCTS").toString();
    const buyProductIdsInput = JSON.parse((formData.get("buyProductIds") || "[]").toString());
    const buyCollectionIds = JSON.parse((formData.get("buyCollectionIds") || "[]").toString());
    const combinesWith = {
        productDiscounts: formData.get("combineProductDiscounts") === "true",
        orderDiscounts: formData.get("combineOrderDiscounts") === "true",
        shippingDiscounts: formData.get("combineShippingDiscounts") === "true",
    };
    let tiers;
    try {
        tiers = JSON.parse((formData.get("tiers") || "[]").toString());
    } catch {
        tiers = [];
    }

    if (!title) {
        return { userErrors: [{ field: ["title"], message: "Discount title is required" }] };
    }
    if (discountMethod === "CODE" && !code) {
        return { userErrors: [{ field: ["code"], message: "Discount code is required" }] };
    }
    if (appliesToType === "PRODUCTS" && (!Array.isArray(buyProductIdsInput) || buyProductIdsInput.length === 0)) {
        return { userErrors: [{ field: ["buyProductIds"], message: "Select at least one product" }] };
    }
    if (appliesToType === "COLLECTIONS" && (!Array.isArray(buyCollectionIds) || buyCollectionIds.length === 0)) {
        return { userErrors: [{ field: ["buyCollectionIds"], message: "Select at least one collection" }] };
    }
    if (!Array.isArray(tiers) || tiers.length === 0 || tiers.length > MAX_TIERS) {
        return { userErrors: [{ field: ["tiers"], message: `Add between 1 and ${MAX_TIERS} tiers` }] };
    }
    for (const tier of tiers) {
        if (!tier.giftProductIds?.length) {
            return { userErrors: [{ field: ["tiers"], message: "Select a gift product for every tier" }] };
        }
        const requirement = conditionType === "AMOUNT" ? tier.requiredAmount : tier.requiredQuantity;
        if (!requirement || Number(requirement) <= 0) {
            return { userErrors: [{ field: ["tiers"], message: "Set a required amount or quantity for every tier" }] };
        }
        if (!tier.giftQuantity || Number(tier.giftQuantity) <= 0) {
            return { userErrors: [{ field: ["tiers"], message: "Set a gift quantity for every tier" }] };
        }
    }

    const recurringCycleLimit = purchaseType === "ONE_TIME" ? null : 1;

    try {
    // "Specific collections" is a merchant-facing convenience: the Function can only match
    // cart lines against a fixed product-id list (it can't dynamically resolve a merchant's
    // collection config at runtime), so collection membership is flattened into buyProductIds
    // here, at save time. This snapshot refreshes every time the discount is saved.
    let buyProductIds = [];
    if (appliesToType === "PRODUCTS") {
        buyProductIds = buyProductIdsInput;
    } else if (appliesToType === "COLLECTIONS") {
        const collectionProductIds = new Set();
        for (const collectionId of buyCollectionIds) {
            const collectionResponse = await admin.graphql(`
                #graphql
                query GetCollectionProductIds($id: ID!) {
                    collection(id: $id) {
                        products(first: 250) {
                            nodes { id }
                        }
                    }
                }
            `, { variables: { id: collectionId } });
            const nodes = (await collectionResponse.json()).data.collection?.products?.nodes ?? [];
            for (const node of nodes) collectionProductIds.add(node.id);
        }
        buyProductIds = [...collectionProductIds];
    }

    // The storefront auto-add script (extensions/gift-with-purchase-theme) can only add a specific
    // variant to the cart, not "a product" — resolve each gift product to its first/default
    // variant here, at save time, since the Function/storefront have no way to browse the catalog.
    const allGiftProductIds = [...new Set(tiers.flatMap((tier) => tier.giftProductIds ?? []))];
    let giftVariantIdByProductId = {};
    if (allGiftProductIds.length) {
        const variantResponse = await admin.graphql(`
            #graphql
            query GetGiftVariantIds($ids: [ID!]!) {
                nodes(ids: $ids) {
                    ... on Product { id variants(first: 1) { nodes { id } } }
                }
            }
        `, { variables: { ids: allGiftProductIds } });
        for (const node of (await variantResponse.json()).data.nodes ?? []) {
            if (node?.id) giftVariantIdByProductId[node.id] = node.variants?.nodes[0]?.id ?? null;
        }
    }

    const config = {
        title,
        conditionType,
        giftAddMode,
        appliesToType,
        buyProductIds,
        buyCollectionIds: appliesToType === "COLLECTIONS" ? buyCollectionIds : [],
        purchaseType,
        excludeCompareAtPrices,
        selectionStrategy,
        tiers: tiers.map((tier) => ({
            requiredQuantity: conditionType === "QUANTITY" ? Number(tier.requiredQuantity) : null,
            requiredAmount: conditionType === "AMOUNT" ? Number(tier.requiredAmount) : null,
            giftQuantity: Number(tier.giftQuantity),
            giftProductIds: tier.giftProductIds,
            giftVariantIds: tier.giftProductIds.map((id) => giftVariantIdByProductId[id]).filter(Boolean),
        })),
    };

    const metafields = [{
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
        type: "json",
        value: JSON.stringify(config),
    }];

    if (isNew) {
        const functionResponse = await admin.graphql(`
            #graphql
            query GetGiftWithPurchaseFunctionId {
                shopifyFunctions(first: 5, apiType: "product_discounts") {
                    nodes { id }
                }
            }
        `);
        const functionId = (await functionResponse.json()).data.shopifyFunctions.nodes[0]?.id;
        if (!functionId) {
            return { userErrors: [{ field: [], message: "Gift with purchase function isn't deployed yet" }] };
        }

        if (discountMethod === "CODE") {
            const response = await admin.graphql(`
                #graphql
                mutation CreateGiftWithPurchaseCode($codeAppDiscount: DiscountCodeAppInput!) {
                    discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
                        codeAppDiscount { discountId }
                        userErrors { field message }
                    }
                }
            `, {
                variables: {
                    codeAppDiscount: {
                        title, code, functionId, startsAt: startsAt || new Date().toISOString(), endsAt,
                        combinesWith, metafields, recurringCycleLimit,
                    },
                },
            });
            const result = (await response.json()).data.discountCodeAppCreate;
            if (result.userErrors?.length) return { userErrors: result.userErrors };

            await db.giftWithPurchase.create({
                data: { shop, shopifyDiscountId: result.codeAppDiscount.discountId, discountMethod: "CODE" },
            });
            return { success: true };
        }

        const response = await admin.graphql(`
            #graphql
            mutation CreateGiftWithPurchaseAutomatic($automaticAppDiscount: DiscountAutomaticAppInput!) {
                discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
                    automaticAppDiscount { discountId }
                    userErrors { field message }
                }
            }
        `, {
            variables: {
                automaticAppDiscount: {
                    title, functionId, startsAt: startsAt || new Date().toISOString(), endsAt,
                    combinesWith, metafields, recurringCycleLimit,
                },
            },
        });
        const result = (await response.json()).data.discountAutomaticAppCreate;
        if (result.userErrors?.length) return { userErrors: result.userErrors };

        await db.giftWithPurchase.create({
            data: { shop, shopifyDiscountId: result.automaticAppDiscount.discountId, discountMethod: "AUTOMATIC" },
        });
        return { success: true };
    }

    // Update: never re-resolve the function id or create a new discount, just update the existing one.
    const numericId = params.id.toString().split("/").pop();

    if (discountMethod === "CODE") {
        const id = `gid://shopify/DiscountCodeNode/${numericId}`;
        const response = await admin.graphql(`
            #graphql
            mutation UpdateGiftWithPurchaseCode($id: ID!, $codeAppDiscount: DiscountCodeAppInput!) {
                discountCodeAppUpdate(id: $id, codeAppDiscount: $codeAppDiscount) {
                    codeAppDiscount { discountId }
                    userErrors { field message }
                }
            }
        `, {
            variables: { id, codeAppDiscount: { title, startsAt: startsAt || undefined, endsAt, combinesWith, metafields, recurringCycleLimit } },
        });
        const result = (await response.json()).data.discountCodeAppUpdate;
        if (result.userErrors?.length) return { userErrors: result.userErrors };

        await db.giftWithPurchase.upsert({
            where: { shop_shopifyDiscountId: { shop, shopifyDiscountId: id } },
            update: { discountMethod: "CODE" },
            create: { shop, shopifyDiscountId: id, discountMethod: "CODE" },
        });
        return { success: true };
    }

    const id = `gid://shopify/DiscountAutomaticNode/${numericId}`;
    const response = await admin.graphql(`
        #graphql
        mutation UpdateGiftWithPurchaseAutomatic($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
            discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
                automaticAppDiscount { discountId }
                userErrors { field message }
            }
        }
    `, {
        variables: { id, automaticAppDiscount: { title, startsAt: startsAt || undefined, endsAt, combinesWith, metafields, recurringCycleLimit } },
    });
    const result = (await response.json()).data.discountAutomaticAppUpdate;
    if (result.userErrors?.length) return { userErrors: result.userErrors };

    await db.giftWithPurchase.upsert({
        where: { shop_shopifyDiscountId: { shop, shopifyDiscountId: id } },
        update: { discountMethod: "AUTOMATIC" },
        create: { shop, shopifyDiscountId: id, discountMethod: "AUTOMATIC" },
    });
    return { success: true };
    } catch (error) {
        console.error("Gift with purchase save failed", error);
        return {
            userErrors: [{
                field: [],
                message: error instanceof Error ? error.message : "Something went wrong saving this discount",
            }],
        };
    }
};

// UI
export default function GiftWithPurchaseForm() {
    const { isNew, discount, products, collections } = useLoaderData();
    const { t: { common: c, giftWithPurchase: t } } = useLanguage();
    const navigate = useNavigate();
    const fetcher = useFetcher();
    const searchFetcher = useFetcher();
    const collectionSearchFetcher = useFetcher();
    const giftSearchFetcher = useFetcher();
    const result = fetcher.data;
    const isSaving = fetcher.state !== "idle";

    const [initial] = useState(() => discount ?? {
        discountMethod: "AUTOMATIC",
        code: "",
        title: "",
        conditionType: "QUANTITY",
        giftAddMode: "MANUAL",
        appliesToType: "PRODUCTS",
        buyProducts: [],
        buyCollections: [],
        purchaseType: "BOTH",
        excludeCompareAtPrices: false,
        selectionStrategy: "WIDGET_ONLY",
        tiers: [emptyTier()],
        startsAt: null,
        endsAt: null,
        combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false },
    });

    const [discountMethod, setDiscountMethod] = useState(initial.discountMethod);
    const [code, setCode] = useState(initial.code);
    const [title, setTitle] = useState(initial.title);
    const [conditionType, setConditionType] = useState(initial.conditionType);
    const [giftAddMode, setGiftAddMode] = useState(initial.giftAddMode ?? "MANUAL");
    const [appliesToType, setAppliesToType] = useState(initial.appliesToType ?? "PRODUCTS");
    const [buyProducts, setBuyProducts] = useState(initial.buyProducts);
    const [buySearchTerm, setBuySearchTerm] = useState("");
    const [buyCollections, setBuyCollections] = useState(initial.buyCollections ?? []);
    const [buyCollectionsSearchTerm, setBuyCollectionsSearchTerm] = useState("");
    const [purchaseType, setPurchaseType] = useState(initial.purchaseType);
    const [excludeCompareAtPrices, setExcludeCompareAtPrices] = useState(initial.excludeCompareAtPrices);
    const [selectionStrategy, setSelectionStrategy] = useState(initial.selectionStrategy);
    const [tiers, setTiers] = useState(initial.tiers.length ? initial.tiers : [emptyTier()]);
    const [activeTierIndex, setActiveTierIndex] = useState(null);
    const [giftSearchTerm, setGiftSearchTerm] = useState("");
    const [combineProductDiscounts, setCombineProductDiscounts] = useState(Boolean(initial.combinesWith?.productDiscounts));
    const [combineOrderDiscounts, setCombineOrderDiscounts] = useState(Boolean(initial.combinesWith?.orderDiscounts));
    const [combineShippingDiscounts, setCombineShippingDiscounts] = useState(Boolean(initial.combinesWith?.shippingDiscounts));
    const [startsAt, setStartsAt] = useState(initial.startsAt ? initial.startsAt.slice(0, 10) : new Date().toISOString().slice(0, 10));
    const [hasEndDate, setHasEndDate] = useState(Boolean(initial.endsAt));
    const [endsAt, setEndsAt] = useState(initial.endsAt ? initial.endsAt.slice(0, 10) : "");

    const isCodeMethod = discountMethod === "CODE";
    const effectiveSelectionStrategy = isCodeMethod ? "ANY_MATCHING" : selectionStrategy;

    const buySearchResults = (searchFetcher.data?.products ?? products ?? []).filter(
        (product) => !buyProducts.some((selected) => selected.id === product.id),
    );
    const buyCollectionsSearchResults = (collectionSearchFetcher.data?.collections ?? collections ?? []).filter(
        (collection) => !buyCollections.some((selected) => selected.id === collection.id),
    );
    const giftSearchResults = (giftSearchFetcher.data?.products ?? []).filter(
        (product) => activeTierIndex == null || !tiers[activeTierIndex].giftProducts.some((selected) => selected.id === product.id),
    );

    // The picker returns full replacement selections shaped like Admin resource objects;
    // normalize to the { id, title, featuredImage/image } shape used everywhere else here.
    const normalizeProduct = (product) => ({
        id: product.id,
        title: product.title,
        featuredImage: { url: product.images?.[0]?.originalSrc ?? product.images?.[0]?.url ?? null },
    });
    const normalizeCollection = (collection) => ({
        id: collection.id,
        title: collection.title,
        image: { url: collection.image?.originalSrc ?? collection.image?.url ?? null },
    });

    const browseBuyProducts = async () => {
        const selected = await shopify.resourcePicker({
            type: "product",
            action: "select",
            multiple: true,
            selectionIds: buyProducts.map((product) => ({ id: product.id })),
        });
        if (selected) setBuyProducts(selected.map(normalizeProduct));
    };
    const browseBuyCollections = async () => {
        const selected = await shopify.resourcePicker({
            type: "collection",
            action: "select",
            multiple: true,
            selectionIds: buyCollections.map((collection) => ({ id: collection.id })),
        });
        if (selected) setBuyCollections(selected.map(normalizeCollection));
    };
    const browseGiftProducts = async (index) => {
        const selected = await shopify.resourcePicker({
            type: "product",
            action: "select",
            multiple: true,
            selectionIds: tiers[index].giftProducts.map((product) => ({ id: product.id })),
        });
        if (selected) updateTier(index, { giftProducts: selected.map(normalizeProduct) });
    };

    useEffect(() => {
        const term = buySearchTerm.trim();
        if (!term) return;
        const timeout = setTimeout(() => {
            searchFetcher.load(`/app/gift-with-purchase/${isNew ? "new" : initial.numericId}?q=${encodeURIComponent(term)}&resource=product`);
        }, 300);
        return () => clearTimeout(timeout);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [buySearchTerm]);

    useEffect(() => {
        const term = buyCollectionsSearchTerm.trim();
        if (!term) return;
        const timeout = setTimeout(() => {
            collectionSearchFetcher.load(`/app/gift-with-purchase/${isNew ? "new" : initial.numericId}?q=${encodeURIComponent(term)}&resource=collection`);
        }, 300);
        return () => clearTimeout(timeout);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [buyCollectionsSearchTerm]);

    useEffect(() => {
        const term = giftSearchTerm.trim();
        if (!term || activeTierIndex == null) return;
        const timeout = setTimeout(() => {
            giftSearchFetcher.load(`/app/gift-with-purchase/${isNew ? "new" : initial.numericId}?q=${encodeURIComponent(term)}`);
        }, 300);
        return () => clearTimeout(timeout);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [giftSearchTerm, activeTierIndex]);

    useEffect(() => {
        if (result?.success && !isSaving) {
            shopify.toast.show(isNew ? t.savedToast : t.updatedToast);
            navigate("/app/discounts");
        } else if (result?.userErrors?.length && !isSaving) {
            shopify.toast.show(result.userErrors[0].message, { isError: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [result, isSaving]);

    const addBuyProduct = (product) => {
        setBuyProducts((current) => (current.some((p) => p.id === product.id) ? current : [...current, product]));
        setBuySearchTerm("");
    };
    const removeBuyProduct = (productId) => {
        setBuyProducts((current) => current.filter((p) => p.id !== productId));
    };

    const updateTier = (index, patch) => {
        setTiers((current) => current.map((tier, i) => (i === index ? { ...tier, ...patch } : tier)));
    };
    const addTier = () => {
        if (tiers.length >= MAX_TIERS) return;
        setTiers((current) => [...current, emptyTier()]);
    };
    const removeTier = (index) => {
        setTiers((current) => current.filter((_, i) => i !== index));
        if (activeTierIndex === index) setActiveTierIndex(null);
    };
    const addGiftProduct = (index, product) => {
        updateTier(index, {
            giftProducts: tiers[index].giftProducts.some((p) => p.id === product.id)
                ? tiers[index].giftProducts
                : [...tiers[index].giftProducts, product],
        });
        setGiftSearchTerm("");
    };
    const removeGiftProduct = (index, productId) => {
        updateTier(index, { giftProducts: tiers[index].giftProducts.filter((p) => p.id !== productId) });
    };

    const handleDiscard = () => {
        setDiscountMethod(initial.discountMethod);
        setCode(initial.code);
        setTitle(initial.title);
        setConditionType(initial.conditionType);
        setGiftAddMode(initial.giftAddMode ?? "MANUAL");
        setAppliesToType(initial.appliesToType ?? "PRODUCTS");
        setBuyProducts(initial.buyProducts);
        setBuyCollections(initial.buyCollections ?? []);
        setPurchaseType(initial.purchaseType);
        setExcludeCompareAtPrices(initial.excludeCompareAtPrices);
        setSelectionStrategy(initial.selectionStrategy);
        setTiers(initial.tiers.length ? initial.tiers : [emptyTier()]);
        setCombineProductDiscounts(Boolean(initial.combinesWith?.productDiscounts));
        setCombineOrderDiscounts(Boolean(initial.combinesWith?.orderDiscounts));
        setCombineShippingDiscounts(Boolean(initial.combinesWith?.shippingDiscounts));
        setHasEndDate(Boolean(initial.endsAt));
        setEndsAt(initial.endsAt ? initial.endsAt.slice(0, 10) : "");
    };

    const handleSubmit = (event) => {
        event.preventDefault();
        const formData = new FormData();
        formData.set("discountMethod", discountMethod);
        formData.set("code", code);
        formData.set("title", title);
        formData.set("conditionType", conditionType);
        formData.set("giftAddMode", giftAddMode);
        formData.set("appliesToType", appliesToType);
        formData.set("buyProductIds", JSON.stringify(buyProducts.map((p) => p.id)));
        formData.set("buyCollectionIds", JSON.stringify(buyCollections.map((c) => c.id)));
        formData.set("purchaseType", purchaseType);
        formData.set("excludeCompareAtPrices", String(excludeCompareAtPrices));
        formData.set("selectionStrategy", effectiveSelectionStrategy);
        formData.set("combineProductDiscounts", String(combineProductDiscounts));
        formData.set("combineOrderDiscounts", String(combineOrderDiscounts));
        formData.set("combineShippingDiscounts", String(combineShippingDiscounts));
        formData.set("startsAt", startsAt ? new Date(startsAt).toISOString() : "");
        formData.set("hasEndDate", String(hasEndDate));
        formData.set("endsAt", hasEndDate && endsAt ? new Date(endsAt).toISOString() : "");
        formData.set("tiers", JSON.stringify(tiers.map((tier) => ({
            requiredQuantity: tier.requiredQuantity,
            requiredAmount: tier.requiredAmount,
            giftQuantity: tier.giftQuantity,
            giftProductIds: tier.giftProducts.map((p) => p.id),
        }))));
        fetcher.submit(formData, { method: "post" });
    };

    const adminDiscountUrl = isNew ? null : `https://${initial.shop}/admin/discounts/${initial.numericId}`;

    return (
        <s-page heading={isNew ? t.heading : title}>
            <s-link href="/app/discounts" slot="breadcrumb-actions">{t.discountsBreadcrumb}</s-link>
            {!isNew && (
                <s-button href={adminDiscountUrl} target="_blank" slot="secondary-actions">
                    {t.viewInAdmin}
                </s-button>
            )}

            {result?.userErrors?.length > 0 && (
                <s-banner tone="critical">{result.userErrors[0].message}</s-banner>
            )}

            <form data-save-bar data-discard-confirmation onSubmit={handleSubmit} onReset={handleDiscard}>
                <s-stack direction="block" gap="base">
                    <s-section heading={t.discountMethodSection}>
                        <s-stack direction="block" gap="base">
                            <s-choice-list
                                label={t.discountMethodLabel}
                                labelAccessibilityVisibility="exclusive"
                                name="discountMethodChoice"
                                values={[discountMethod]}
                                onChange={(event) => setDiscountMethod(event.currentTarget.values[0])}
                            >
                                <s-choice value="AUTOMATIC">{t.methodAutomatic}</s-choice>
                                <s-choice value="CODE">{t.methodCode}</s-choice>
                            </s-choice-list>

                            {isCodeMethod && (
                                <s-text-field
                                    label={t.discountCodeLabel}
                                    name="codeField"
                                    required
                                    details={t.discountCodeDetails}
                                    value={code}
                                    onInput={(event) => setCode(event.currentTarget.value)}
                                />
                            )}

                            <s-text-field
                                label={t.discountTitleLabel}
                                name="titleField"
                                required
                                details={t.discountTitleDetails}
                                value={title}
                                onInput={(event) => setTitle(event.currentTarget.value)}
                            />
                        </s-stack>
                    </s-section>

                    <s-section heading={t.conditionTypeSectionHeading}>
                        <s-select
                            label={t.conditionTypeLabel}
                            name="conditionTypeField"
                            value={conditionType}
                            onChange={(event) => setConditionType(event.currentTarget.value)}
                        >
                            <s-option value="QUANTITY">{t.conditionQuantity}</s-option>
                            <s-option value="AMOUNT">{t.conditionAmount}</s-option>
                        </s-select>
                    </s-section>

                    <s-section heading={t.appliesToSectionHeading}>
                        <s-stack direction="block" gap="base">
                            <s-select
                                label={t.appliesToLabel}
                                name="appliesToTypeField"
                                value={appliesToType}
                                onChange={(event) => setAppliesToType(event.currentTarget.value)}
                            >
                                <s-option value="ALL">{t.appliesToAll}</s-option>
                                <s-option value="PRODUCTS">{t.appliesToSpecificProducts}</s-option>
                                <s-option value="COLLECTIONS">{t.appliesToSpecificCollections}</s-option>
                            </s-select>

                            {appliesToType === "PRODUCTS" && (
                                <>
                                    <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="center">
                                        <s-search-field
                                            label={t.appliesToLabel}
                                            labelAccessibilityVisibility="exclusive"
                                            placeholder={t.searchProductsPlaceholder}
                                            value={buySearchTerm}
                                            onInput={(event) => setBuySearchTerm(event.currentTarget.value)}
                                        />
                                        <s-button onClick={browseBuyProducts}>{t.browse}</s-button>
                                    </s-grid>

                                    {buySearchTerm.trim() && buySearchResults.length > 0 && (
                                        <s-box border="base" borderRadius="base" padding="base">
                                            <s-stack direction="block" gap="small-200">
                                                {buySearchResults.map((product) => (
                                                    <s-clickable key={product.id} onClick={() => addBuyProduct(product)}>
                                                        <s-stack direction="inline" gap="small" alignItems="center">
                                                            <s-thumbnail src={product.featuredImage?.url} alt={product.title} size="small" />
                                                            <s-text>{product.title}</s-text>
                                                        </s-stack>
                                                    </s-clickable>
                                                ))}
                                            </s-stack>
                                        </s-box>
                                    )}

                                    {buyProducts.length > 0 && (
                                        <s-stack direction="block" gap="small">
                                            <s-text>{format(t.appliesToCount, { count: buyProducts.length })}</s-text>
                                            {buyProducts.map((product) => (
                                                <s-box key={product.id} border="base" borderRadius="base" padding="base">
                                                    <s-stack direction="inline" gap="small" alignItems="center">
                                                        <s-thumbnail src={product.featuredImage?.url} alt={product.title} size="small" />
                                                        <s-text>{product.title}</s-text>
                                                        <s-button
                                                            icon="delete"
                                                            variant="tertiary"
                                                            tone="critical"
                                                            accessibilityLabel={`Remove ${product.title}`}
                                                            onClick={() => removeBuyProduct(product.id)}
                                                        />
                                                    </s-stack>
                                                </s-box>
                                            ))}
                                        </s-stack>
                                    )}
                                </>
                            )}

                            {appliesToType === "COLLECTIONS" && (
                                <>
                                    <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="center">
                                        <s-search-field
                                            label={t.appliesToLabel}
                                            labelAccessibilityVisibility="exclusive"
                                            placeholder={t.searchCollectionsPlaceholder}
                                            value={buyCollectionsSearchTerm}
                                            onInput={(event) => setBuyCollectionsSearchTerm(event.currentTarget.value)}
                                        />
                                        <s-button onClick={browseBuyCollections}>{t.browse}</s-button>
                                    </s-grid>

                                    {buyCollectionsSearchTerm.trim() && buyCollectionsSearchResults.length > 0 && (
                                        <s-box border="base" borderRadius="base" padding="base">
                                            <s-stack direction="block" gap="small-200">
                                                {buyCollectionsSearchResults.map((collection) => (
                                                    <s-clickable
                                                        key={collection.id}
                                                        onClick={() => {
                                                            setBuyCollections((current) => (current.some((c) => c.id === collection.id) ? current : [...current, collection]));
                                                            setBuyCollectionsSearchTerm("");
                                                        }}
                                                    >
                                                        <s-stack direction="inline" gap="small" alignItems="center">
                                                            <s-thumbnail src={collection.image?.url} alt={collection.title} size="small" />
                                                            <s-text>{collection.title}</s-text>
                                                        </s-stack>
                                                    </s-clickable>
                                                ))}
                                            </s-stack>
                                        </s-box>
                                    )}

                                    {buyCollections.length > 0 && (
                                        <s-stack direction="block" gap="small">
                                            <s-text>{format(t.appliesToCollectionsCount, { count: buyCollections.length })}</s-text>
                                            {buyCollections.map((collection) => (
                                                <s-box key={collection.id} border="base" borderRadius="base" padding="base">
                                                    <s-stack direction="inline" gap="small" alignItems="center">
                                                        <s-thumbnail src={collection.image?.url} alt={collection.title} size="small" />
                                                        <s-text>{collection.title}</s-text>
                                                        <s-button
                                                            icon="delete"
                                                            variant="tertiary"
                                                            tone="critical"
                                                            accessibilityLabel={`Remove ${collection.title}`}
                                                            onClick={() => setBuyCollections((current) => current.filter((c) => c.id !== collection.id))}
                                                        />
                                                    </s-stack>
                                                </s-box>
                                            ))}
                                        </s-stack>
                                    )}
                                </>
                            )}

                            <s-checkbox
                                label={t.excludeCompareAt}
                                name="excludeCompareAtField"
                                checked={excludeCompareAtPrices}
                                onChange={(event) => setExcludeCompareAtPrices(event.currentTarget.checked)}
                            />

                            <s-select
                                label={t.purchaseTypeLabel}
                                name="purchaseTypeField"
                                value={purchaseType}
                                onChange={(event) => setPurchaseType(event.currentTarget.value)}
                            >
                                <s-option value="BOTH">{t.purchaseBoth}</s-option>
                                <s-option value="ONE_TIME">{t.purchaseOneTime}</s-option>
                                <s-option value="SUBSCRIPTION">{t.purchaseSubscription}</s-option>
                            </s-select>

                            <s-choice-list
                                label={t.selectionStrategyLabel}
                                name="selectionStrategyChoice"
                                values={[effectiveSelectionStrategy]}
                                disabled={isCodeMethod}
                                onChange={(event) => setSelectionStrategy(event.currentTarget.values[0])}
                            >
                                <s-choice value="WIDGET_ONLY">{t.strategyWidgetOnly}</s-choice>
                                <s-choice value="ANY_MATCHING">{t.strategyAnyMatching}</s-choice>
                            </s-choice-list>
                            {isCodeMethod && <s-text color="subdued">{t.strategyCodeNotice}</s-text>}

                            {buyProducts.map((product) => (
                                <input key={product.id} type="hidden" name="buyProductIds" value={product.id} />
                            ))}
                        </s-stack>
                    </s-section>

                    <s-section heading={t.giftAddModeSectionHeading}>
                        <s-stack direction="block" gap="small-200">
                            <s-choice-list
                                label={t.giftAddModeLabel}
                                labelAccessibilityVisibility="exclusive"
                                name="giftAddModeChoice"
                                values={[giftAddMode]}
                                onChange={(event) => setGiftAddMode(event.currentTarget.values[0])}
                            >
                                <s-choice value="AUTOMATIC">{t.giftAddModeAutomatic}</s-choice>
                                <s-choice value="MANUAL">{t.giftAddModeManual}</s-choice>
                            </s-choice-list>
                            <s-text color="subdued">
                                {giftAddMode === "AUTOMATIC" ? t.giftAddModeAutomaticDetails : t.giftAddModeManualDetails}
                            </s-text>
                        </s-stack>
                    </s-section>

                    <s-section heading={t.tiersSection}>
                        <s-stack direction="block" gap="base">
                            <s-text color="subdued">{format(t.tiersCount, { count: tiers.length })}</s-text>

                            {tiers.map((tier, index) => (
                                <s-box key={index} border="base" borderRadius="base" padding="base">
                                    <s-stack direction="block" gap="base">
                                        <s-stack direction="inline" gap="base" alignItems="center">
                                            <s-text type="strong">{format(t.tierLabel, { number: index + 1 })}</s-text>
                                            {tiers.length > 1 && (
                                                <s-button
                                                    icon="delete"
                                                    variant="tertiary"
                                                    tone="critical"
                                                    accessibilityLabel={t.removeTier}
                                                    onClick={() => removeTier(index)}
                                                />
                                            )}
                                        </s-stack>

                                        {conditionType === "QUANTITY" ? (
                                            <s-number-field
                                                label={t.requiredQuantityLabel}
                                                min={1}
                                                step={1}
                                                value={tier.requiredQuantity}
                                                onChange={(event) => updateTier(index, { requiredQuantity: event.currentTarget.value })}
                                            />
                                        ) : (
                                            <s-number-field
                                                label={t.requiredAmountLabel}
                                                min={0}
                                                step={0.01}
                                                value={tier.requiredAmount}
                                                onChange={(event) => updateTier(index, { requiredAmount: event.currentTarget.value })}
                                            />
                                        )}

                                        <s-number-field
                                            label={t.giftQuantityLabel}
                                            min={1}
                                            step={1}
                                            value={tier.giftQuantity}
                                            onChange={(event) => updateTier(index, { giftQuantity: event.currentTarget.value })}
                                        />

                                        <s-stack direction="block" gap="small-200">
                                            <s-text>{t.giftSelectionLabel}</s-text>
                                            <s-text color="subdued">{t.giftSelectionDetails}</s-text>
                                        </s-stack>

                                        <s-grid gridTemplateColumns="1fr auto" gap="small" alignItems="center">
                                            <s-search-field
                                                label={t.giftSelectionLabel}
                                                labelAccessibilityVisibility="exclusive"
                                                placeholder={t.searchProductsPlaceholder}
                                                value={activeTierIndex === index ? giftSearchTerm : ""}
                                                onFocus={() => setActiveTierIndex(index)}
                                                onInput={(event) => {
                                                    setActiveTierIndex(index);
                                                    setGiftSearchTerm(event.currentTarget.value);
                                                }}
                                            />
                                            <s-button onClick={() => browseGiftProducts(index)}>{t.browse}</s-button>
                                        </s-grid>

                                        {activeTierIndex === index && giftSearchTerm.trim() && giftSearchResults.length > 0 && (
                                            <s-box border="base" borderRadius="base" padding="base">
                                                <s-stack direction="block" gap="small-200">
                                                    {giftSearchResults.map((product) => (
                                                        <s-clickable key={product.id} onClick={() => addGiftProduct(index, product)}>
                                                            <s-stack direction="inline" gap="small" alignItems="center">
                                                                <s-thumbnail src={product.featuredImage?.url} alt={product.title} size="small" />
                                                                <s-text>{product.title}</s-text>
                                                            </s-stack>
                                                        </s-clickable>
                                                    ))}
                                                </s-stack>
                                            </s-box>
                                        )}

                                        {tier.giftProducts.map((product) => (
                                            <s-box key={product.id} border="base" borderRadius="base" padding="base">
                                                <s-stack direction="inline" gap="small" alignItems="center">
                                                    <s-thumbnail src={product.featuredImage?.url} alt={product.title} size="small" />
                                                    <s-text>{product.title}</s-text>
                                                    <s-button
                                                        icon="delete"
                                                        variant="tertiary"
                                                        tone="critical"
                                                        accessibilityLabel={`Remove ${product.title}`}
                                                        onClick={() => removeGiftProduct(index, product.id)}
                                                    />
                                                </s-stack>
                                            </s-box>
                                        ))}
                                    </s-stack>
                                </s-box>
                            ))}

                            {tiers.length < MAX_TIERS && (
                                <s-button icon="plus" variant="tertiary" onClick={addTier}>
                                    {t.addTier}
                                </s-button>
                            )}
                        </s-stack>
                    </s-section>

                    <s-section heading={t.eligibilitySection}>
                        <s-text>{c.allCustomers}</s-text>
                    </s-section>

                    <s-section heading="Combinations">
                        <s-stack direction="block" gap="small-200">
                            <s-checkbox
                                label="Product discounts"
                                checked={combineProductDiscounts}
                                onChange={(event) => setCombineProductDiscounts(event.currentTarget.checked)}
                            />
                            <s-checkbox
                                label="Order discounts"
                                checked={combineOrderDiscounts}
                                onChange={(event) => setCombineOrderDiscounts(event.currentTarget.checked)}
                            />
                            <s-checkbox
                                label="Shipping discounts"
                                checked={combineShippingDiscounts}
                                onChange={(event) => setCombineShippingDiscounts(event.currentTarget.checked)}
                            />
                        </s-stack>
                    </s-section>

                    <s-section heading="Active dates">
                        <s-stack direction="block" gap="base">
                            <s-date-field
                                label="Start date"
                                value={startsAt}
                                onChange={(event) => setStartsAt(event.currentTarget.value)}
                            />
                            <s-checkbox
                                label="Set end date"
                                checked={hasEndDate}
                                onChange={(event) => setHasEndDate(event.currentTarget.checked)}
                            />
                            {hasEndDate && (
                                <s-date-field
                                    label="End date"
                                    value={endsAt}
                                    onChange={(event) => setEndsAt(event.currentTarget.value)}
                                />
                            )}
                        </s-stack>
                    </s-section>
                </s-stack>
            </form>
        </s-page>
    );
}
