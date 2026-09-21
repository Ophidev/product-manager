import { useFetcher, useLoaderData, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { authenticate } from "../shopify.server";
import { format, useLanguage } from "../context/LanguageContext";
//loader -- read/ get data
export const loader = async ({ request, params }) => {
    console.log("Discount Loader");
    const { admin } = await authenticate.admin(request);
    const isNew = params.id === "new";
//allowing to search to the colleciton q refers to the text 
// which will be inserted q=summer, then it will be trim as 1
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim();
//when we search in the collection to make it visible with title, 
// image, product coun, query is done by title of collection
    let searchedCollections = [];
    if (query) {
        const response = await admin.graphql(`
            #graphql
            query SearchCollectionsForDiscount($query: String!) {
                collections(first: 10, query: $query) {
                    nodes {
                        id
                        title
                        image { url }
                        productsCount { count }
                    }
                }
            }
        `, { variables: { query: `title:*${query}*` } });
//converting the searched response in the Js objects
        searchedCollections = (await response.json()).data.collections.nodes;
    }
//if the discount is new will be true and discount: null
    if (isNew) {
        return { isNew: true, discount: null, collections: searchedCollections };
    }
//discountCodeNode will help to apply the code to the checkouts if not new then open the particular discount
    const discountId = `gid://shopify/DiscountCodeNode/${params.id}`;
// allows to open and show the fetched discounts on the page 
    const response = await admin.graphql(`
        #graphql
        query GetDiscountForEdit($id: ID!) {
            codeDiscountNode(id: $id) {
                id
                codeDiscount {
                    ... on DiscountCodeBasic {
                        title
                        codes(first: 1) {
                            nodes { code }
                        }
                        customerGets {
                            value {
                                ... on DiscountPercentage { percentage }
                            }
                            items {
                                ... on DiscountCollections {
                                    collections(first: 50) {
                                        nodes {
                                            id
                                            title
                                            image { url }
                                            productsCount { count }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    `, { variables: { id: discountId } });
//data will be in the shopify JSON format 
    const data = (await response.json()).data;   
    const codeDiscount = data.codeDiscountNode?.codeDiscount;
//error handling if discount code dont match
    if (!codeDiscount?.title) {
        throw new Response("Discount not found", { status: 404 });
    }

// shopify return the percentage into the decimal format 0.20 give 20%
//math.round(0.20 *100 = 20%)
    const percentage = codeDiscount.customerGets?.value?.percentage;
    const discount = {
        id: data.codeDiscountNode.id,
        code: codeDiscount.codes.nodes[0]?.code ?? "",
        percentage: percentage != null ? String(Math.round(percentage * 100)) : "",
        collections: codeDiscount.customerGets?.items?.collections?.nodes ?? [],
    };

    return { isNew: false, discount, collections: searchedCollections };
};
//action -- /write/update
export const action = async ({ request, params }) => {
    const { admin } = await authenticate.admin(request);
    const isNew = params.id === "new";
//get formData code, percentage collection code fetching
    const formData = await request.formData();
    const code = (formData.get("code") || "").toString().trim();
    const percentageRaw = (formData.get("percentage") || "").toString().trim();
    const collectionIdsRaw = (formData.get("collectionIds") || "[]").toString();
// error handling if there will be no code
    if (!code) {
        return { userErrors: [{ field: ["code"], message: "Discount code is required" }] };
    }
//percentage is less than 1 and more than 100 not allowed means 1-100% else share the error percentage error
    const percentage = Number(percentageRaw);
    if (!percentageRaw || !Number.isFinite(percentage) || percentage < 1 || percentage > 100) {
        return { userErrors: [{ field: ["percentage"], message: "Percentage must be between 1 and 100" }] };
    }

    let collectionIds;
    try {
        collectionIds = JSON.parse(collectionIdsRaw);
    } catch {
        collectionIds = null;
    }
//colelction error if no collection is selected 
    if (
        !Array.isArray(collectionIds) ||
        collectionIds.length === 0 ||
        !collectionIds.every((id) => typeof id === "string" && id.length > 0)
    ) {
        return { userErrors: [{ field: ["collectionIds"], message: "Select at least one collection" }] };
    }
//if it is new
    if (isNew) {
        const response = await admin.graphql(`
            #graphql
            mutation CreateDiscountCode($basicCodeDiscount: DiscountCodeBasicInput!) {
                discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
                    codeDiscountNode { id }
                    userErrors { field message }
                }
            }
        `, {
            variables: {
                basicCodeDiscount: {
                    title: code,
                    code,
                    startsAt: new Date().toISOString(),
                    customerSelection: { all: true },
                    customerGets: {
                        value: { percentage: percentage / 100 },
                        items: { collections: { add: collectionIds } },
                    },
                },
            },
        });

        const result = (await response.json()).data.discountCodeBasicCreate;
        if (result.userErrors?.length) {
            return { userErrors: result.userErrors };
        }

        return { success: true };
    }
// ----------------------------------------------------------------------------------------------------------------------
    const initialCollectionIdsRaw = (formData.get("initialCollectionIds") || "[]").toString();
    let initialCollectionIds;
    try {
        initialCollectionIds = JSON.parse(initialCollectionIdsRaw);
        if (!Array.isArray(initialCollectionIds)) initialCollectionIds = [];
    } catch {
        initialCollectionIds = [];
    }
// initial it has now it don't or it has have to add more  for the edit ones
    const initialIds = new Set(initialCollectionIds);
    const currentIds = new Set(collectionIds);
    const toAdd = collectionIds.filter((id) => !initialIds.has(id));
    const toRemove = initialCollectionIds.filter((id) => !currentIds.has(id));

    const basicCodeDiscount = {
        title: code,
        code,
        customerGets: {
            value: { percentage: percentage / 100 },
        },
    };

    if (toAdd.length || toRemove.length) {
        basicCodeDiscount.customerGets.items = {
            collections: {
                ...(toAdd.length ? { add: toAdd } : {}),
                ...(toRemove.length ? { remove: toRemove } : {}),
            },
        };
    }
//discountcodenode object allows to manage the code on the checkout applied by the customers 
    const discountId = `gid://shopify/DiscountCodeNode/${params.id}`;
    const response = await admin.graphql(`
        #graphql
        mutation UpdateDiscountCode($id: ID!, $basicCodeDiscount: DiscountCodeBasicInput!) {
            discountCodeBasicUpdate(id: $id, basicCodeDiscount: $basicCodeDiscount) {
                codeDiscountNode { id }
                userErrors { field message }
            }
        }
    `, { variables: { id: discountId, basicCodeDiscount } });

    const result = (await response.json()).data.discountCodeBasicUpdate;
    if (result.userErrors?.length) {
        return { userErrors: result.userErrors };
    }

    return { success: true };
};
//UI 
export default function DiscountForm() {
    const { isNew, discount, collections } = useLoaderData();
    const { t: { common: c, discountForm: t } } = useLanguage();
    const navigate = useNavigate();
    const fetcher = useFetcher();
    const searchFetcher = useFetcher();
    const result = fetcher.data;
    const isSaving = fetcher.state !== "idle";

    const [initial] = useState(() => discount ?? { code: "", percentage: "", collections: [] });

    const [code, setCode] = useState(initial.code);
    const [percentage, setPercentage] = useState(initial.percentage);
    const [searchTerm, setSearchTerm] = useState("");
    const [selectedCollections, setSelectedCollections] = useState(initial.collections);

    const searchResults = (searchFetcher.data?.collections ?? collections ?? []).filter(
        (collection) => !selectedCollections.some((selected) => selected.id === collection.id),
    );
//used for the searching the colleciton with the 300ms 
    useEffect(() => {
        const term = searchTerm.trim();
        if (!term) return;
        const timeout = setTimeout(() => {
            searchFetcher.load(`/app/discounts/${isNew ? "new" : initial.id.split("/").pop()}?q=${encodeURIComponent(term)}`);
        }, 300);
        return () => clearTimeout(timeout);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchTerm]);

    useEffect(() => {
        if (result?.success && !isSaving) {
            shopify.toast.show(isNew ? t.savedToast : t.updatedToast);
            navigate("/app/discounts");
        } else if (result?.userErrors?.length && !isSaving) {
            shopify.toast.show(result.userErrors[0].message, { isError: true });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [result, isSaving]);
//add more collection 
    const addCollection = (collection) => {
        setSelectedCollections((current) => {
            if (current.some((selected) => selected.id === collection.id)) return current;
            return [...current, collection];
        });
        setSearchTerm("");
    };
//remove collection
    const removeCollection = (collectionId) => {
        setSelectedCollections((current) => current.filter((collection) => collection.id !== collectionId));
    };
//handle colleciton delete
    const handleDiscard = () => {
        setCode(initial.code);
        setPercentage(initial.percentage);
        setSearchTerm("");
        setSelectedCollections(initial.collections);
    };
//handle submit with the help of handleSubmit 
    const handleSubmit = (event) => {
        event.preventDefault();

        const formData = new FormData();
        formData.set("code", code);
        formData.set("percentage", percentage);
        formData.set("collectionIds", JSON.stringify(selectedCollections.map((collection) => collection.id)));

        if (!isNew) {
            formData.set("initialCollectionIds", JSON.stringify(initial.collections.map((collection) => collection.id)));
        }

        fetcher.submit(formData, { method: "post" });
    };

    return (
        <s-page heading={isNew ? t.createDiscountHeading : initial.code}>
            <s-link href="/app/discounts" slot="breadcrumb-actions">{t.discountsBreadcrumb}</s-link>

            {result?.userErrors?.length > 0 && (
                <s-banner tone="critical">
                    {result.userErrors[0].message}
                </s-banner>
            )}

            <form data-save-bar data-discard-confirmation onSubmit={handleSubmit} onReset={handleDiscard}>
                <s-stack direction="block" gap="base">
                    <s-section heading={t.amountOffProducts}>
                        <s-text-field
                            label={t.discountCodeLabel}
                            name="code"
                            required
                            placeholder={t.discountCodePlaceholder}
                            details={t.discountCodeDetails}
                            value={code}
                            onInput={(event) => setCode(event.currentTarget.value)}
                        />
                    </s-section>

                    <s-section heading={t.discountValue}>
                        <s-stack direction="block" gap="base">
                            <s-number-field
                                label={t.percentage}
                                name="percentage"
                                suffix="%"
                                required
                                min={1}
                                max={100}
                                step={1}
                                value={percentage}
                                onChange={(event) => setPercentage(event.currentTarget.value)}
                            />

                            <s-stack direction="block" gap="small-200">
                                <s-text>{t.appliesTo}</s-text>
                                <s-text>{t.specificCollections}</s-text>
                            </s-stack>

                            <s-search-field
                                label={t.searchCollections}
                                labelAccessibilityVisibility="exclusive"
                                placeholder={t.searchCollections}
                                value={searchTerm}
                                onInput={(event) => setSearchTerm(event.currentTarget.value)}
                            />

                            {searchTerm.trim() && searchResults.length > 0 && (
                                <s-box border="base" borderRadius="base" padding="base">
                                    <s-stack direction="block" gap="small-200">
                                        {searchResults.map((collection) => (
                                            <s-clickable key={collection.id} onClick={() => addCollection(collection)}>
                                                <s-stack direction="inline" gap="small" alignItems="center">
                                                    <s-thumbnail src={collection.image?.url} alt={collection.title} size="small" />
                                                    <s-text>{collection.title}</s-text>
                                                </s-stack>
                                            </s-clickable>
                                        ))}
                                    </s-stack>
                                </s-box>
                            )}

                            {selectedCollections.length > 0 && (
                                <s-stack direction="block" gap="small">
                                    {selectedCollections.map((collection) => (
                                        <s-box key={collection.id} border="base" borderRadius="base" padding="base">
                                            <s-stack direction="inline" gap="small" alignItems="center">
                                                <s-thumbnail src={collection.image?.url} alt={collection.title} size="small" />
                                                <s-stack direction="block" gap="small-200">
                                                    <s-text>{collection.title}</s-text>
                                                    {typeof collection.productsCount?.count === "number" && (
                                                        <s-text color="subdued">{format(t.productsCount, { count: collection.productsCount.count })}</s-text>
                                                    )}
                                                </s-stack>
                                                <s-button
                                                    icon="delete"
                                                    variant="tertiary"
                                                    tone="critical"
                                                    accessibilityLabel={`Remove ${collection.title}`}
                                                    onClick={() => removeCollection(collection.id)}
                                                />
                                            </s-stack>
                                        </s-box>
                                    ))}
                                </s-stack>
                            )}

                            {selectedCollections.map((collection) => (
                                <input key={collection.id} type="hidden" name="collectionIds" value={collection.id} />
                            ))}
                        </s-stack>
                    </s-section>

                    <s-section heading={t.eligibilitySection}>
                        <s-text>{c.allCustomers}</s-text>
                    </s-section>
                </s-stack>
            </form>
        </s-page>
    );
}
