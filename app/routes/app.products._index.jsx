import { useLoaderData, useNavigate, useFetcher, useSearchParams } from "react-router";
import { useEffect, useRef, useCallback, useState, useMemo } from "react";
import { authenticate } from "../shopify.server";
import { useLanguage } from "../context/LanguageContext";
import { format } from "../context/languageData";
  
const FILTER_QUERIES = {
    active: "status:active",
    draft: "status:draft",
    out_of_stock: "inventory_total:0",
    low_inventory: "inventory_total:<=5",
};
//present the result in this format
const SORT_KEYS = {
    "product-title": "TITLE",
    inventory: "INVENTORY_TOTAL",
    created: "CREATED_AT",
};

const PRODUCT_FIELDS = `
    id
    title
    status
    totalInventory
    createdAt
    updatedAt
    tags
    featuredImage { url altText }
    variants(first: 1) { nodes { id price } }
`;
//fetching data on server-end before rendering the page--getdata
export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    //reading URL query Parameters 
    // after page and before page 
    const after = url.searchParams.get("after");
    const before = url.searchParams.get("before");
    const filter = url.searchParams.get("filter");
    const search = url.searchParams.get("search");
    // if sort side is null or undefined not available print right side sort =   product-title
    const sort = url.searchParams.get("sort") ?? "product-title";
    // if order is null undefined in the params run the right side asc or desc 
    const order = url.searchParams.get("order") ?? "asc";

    const queryParts = [];
    ///products?filter=active;search=coffee
    if (FILTER_QUERIES[filter]) queryParts.push(FILTER_QUERIES[filter]);
    if (search) queryParts.push(`title:*${search}*`);
    //if  there is no conditon fetch all the products  
    const query = queryParts.length ? queryParts.join(" AND ") : null;
    //if the sort keys share the invalid data it will represent the data 
    const sortKey = SORT_KEYS[sort] ?? "TITLE";
    // if it is asc reverse = false vice versa
    const reverse = order === "desc";

    let response;

    if (before) {
        response = await admin.graphql(`
            #graphql
            query GetProducts($last: Int!, $before: String!, $query: String, $sortKey: ProductSortKeys, $reverse: Boolean) {
                shop { currencyCode }
                products(last: $last, before: $before, query: $query, sortKey: $sortKey, reverse: $reverse) {
                    nodes { ${PRODUCT_FIELDS} }
                    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
                }
            }
        `, { variables: { last: 10, before, query, sortKey, reverse } });
    } else if (after) {
        response = await admin.graphql(`
            #graphql
            query GetProducts($first: Int!, $after: String!, $query: String, $sortKey: ProductSortKeys, $reverse: Boolean) {
                shop { currencyCode }
                products(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
                    nodes { ${PRODUCT_FIELDS} }
                    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
                }
            }
        `, { variables: { first: 10, after, query, sortKey, reverse } });
    } else {
        response = await admin.graphql(`
            #graphql
            query GetProducts($first: Int!, $query: String, $sortKey: ProductSortKeys, $reverse: Boolean) {
                shop { currencyCode }
                products(first: $first, query: $query, sortKey: $sortKey, reverse: $reverse) {
                    nodes { ${PRODUCT_FIELDS} }
                    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
                }
            }
        `, { variables: { first: 10, query, sortKey, reverse } });
    }

    const data = await response.json();
    return { ...data.data, filter, search: search ?? "", sort, order };
};
//action --read/write
export const action = async ({ request }) => {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");
//action bulk status
    if (intent === "bulkStatus") {
        const status = formData.get("status");
        const items = JSON.parse(formData.get("items") || "[]");

        const results = await Promise.all(
            items.map(async ({ id }) => {
                const response = await admin.graphql(`
                    #graphql
                    mutation BulkUpdateStatus($product: ProductUpdateInput!) {
                        productUpdate(product: $product) {
                            product { id status }
                            userErrors { field message }
                        }
                    }
                `, { variables: { product: { id, status } } });
                return (await response.json()).data.productUpdate;
            }),
        );

        const userErrors = results.flatMap((result) => result.userErrors ?? []);
        return { bulk: "status", count: items.length, userErrors };
    }
// aciton bulk price 
    if (intent === "bulkPrice") {
        const mode = formData.get("mode") ?? "set";
        const value = Number(formData.get("value"));
        const items = JSON.parse(formData.get("items") || "[]");

        const results = await Promise.all(
            items.map(async ({ id, variantId, price }) => {
                const newPrice = mode === "percent"
                    ? (Number(price) * (1 + value / 100)).toFixed(2)
                    : value.toFixed(2);
                const response = await admin.graphql(`
                    #graphql
                    mutation BulkUpdatePrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                            productVariants { id price }
                            userErrors { field message }
                        }
                    }
                `, { variables: { productId: id, variants: [{ id: variantId, price: newPrice }] } });
                return (await response.json()).data.productVariantsBulkUpdate;
            }),
        );

        const userErrors = results.flatMap((result) => result.userErrors ?? []);
        return { bulk: "price", count: items.length, userErrors };
    }
//action bulk tags
    if (intent === "bulkTags") {
        const tags = (formData.get("tags") || "")
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean);
        const items = JSON.parse(formData.get("items") || "[]");

        const results = await Promise.all(
            items.map(async ({ id }) => {
                const response = await admin.graphql(`
                    #graphql
                    mutation BulkUpdateTags($product: ProductUpdateInput!) {
                        productUpdate(product: $product) {
                            product { id tags }
                            userErrors { field message }
                        }
                    }
                `, { variables: { product: { id, tags } } });
                return (await response.json()).data.productUpdate;
            }),
        );

        const userErrors = results.flatMap((result) => result.userErrors ?? []);
        return { bulk: "tags", count: items.length, userErrors };
    }
//action bulk delete
    if (intent === "bulkDelete") {
        const items = JSON.parse(formData.get("items") || "[]");

        const results = await Promise.all(
            items.map(async ({ id }) => {
                const response = await admin.graphql(`
                    #graphql
                    mutation BulkDeleteProduct($input: ProductDeleteInput!) {
                        productDelete(input: $input) {
                            deletedProductId
                            userErrors { field message }
                        }
                    }
                `, { variables: { input: { id } } });
                return (await response.json()).data.productDelete;
            }),
        );

        const userErrors = results.flatMap((result) => result.userErrors ?? []);
        return { bulk: "delete", count: items.length, userErrors };
    }

    return null;
};

//UI
export default function Products() {
    const { products, shop, filter, search: initialSearch, sort, order } = useLoaderData();
    const { t: { common: c, products: t } } = useLanguage();
    const currencyFormatter = useMemo(
        () => new Intl.NumberFormat(undefined, { style: "currency", currency: shop?.currencyCode ?? "USD" }),
        [shop?.currencyCode],
    );
    const FILTER_LABELS = {
        active: t.filterActive,
        draft: t.filterDraft,
        out_of_stock: t.filterOutOfStock,
        low_inventory: t.filterLowInventory,
    };
    const [searchInput, setSearchInput] = useState(initialSearch);
    const [selectedProductsMap, setSelectedProductsMap] = useState(() => new Map());   //map used 
    const [bulkStatus, setBulkStatus] = useState("ACTIVE");
    const [bulkPriceMode, setBulkPriceMode] = useState("set");
    const [bulkPrice, setBulkPrice] = useState("");
    const [bulkTags, setBulkTags] = useState("");

    const bulkFetcher = useFetcher();

    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const tableRef = useRef(null);
    const bulkResult = bulkFetcher.data;
//using of search in index table for finding the product on all pages by searchparams 
    const handleNextPage = useCallback(() => {
        const cursor = products.pageInfo.endCursor;
        const params = new URLSearchParams(searchParams);
        params.delete("before");
        params.set("after", cursor);
        navigate(`/app/products?${params.toString()}`);
    }, [products.pageInfo.endCursor, navigate, searchParams]);

    const handlePreviousPage = useCallback(() => {
        const cursor = products.pageInfo.startCursor;
        const params = new URLSearchParams(searchParams);
        params.delete("after");
        params.set("before", cursor);
        navigate(`/app/products?${params.toString()}`);
    }, [products.pageInfo.startCursor, navigate, searchParams]);
 
// When the page/filter changes, remove the old "after" and "before" 
// cursors so that pagination starts fresh with the new parameters.
    const updateParam = useCallback((key, value) => {
        const params = new URLSearchParams(searchParams);
        // If a value is provided, add/update that parameter in the URL
        if (value) {
            params.set(key, value);
            // If the value is empty, remove that parameter from the URL
        } else {
            params.delete(key);
        }
        // Remove the old pagination cursors because the query has changed
        params.delete("after");
        params.delete("before");
        // Navigate to the products page with the updated parameters
        navigate(`/app/products?${params.toString()}`, { replace: true });
    }, [navigate, searchParams]);

    //when the searching search Input ends useEffect will work 200ms output
    useEffect(() => {
        if (searchInput === initialSearch) return;
        const handle = setTimeout(() => updateParam("search", searchInput), 200);
        //if typing done under 200ms return cancel search again
        return () => clearTimeout(handle);
    }, [searchInput]);

    const filteredProducts = products.nodes;
    //selected products, tracked across pages (keyed by id) so selections survive pagination
    const selectedProducts = Array.from(selectedProductsMap.values());   //selected product 

    const allSelected = filteredProducts.length > 0
        && filteredProducts.every((product) => selectedProductsMap.has(product.id));
//set selected product 
    const toggleAll = () => {
        setSelectedProductsMap((current) => {
            const next = new Map(current);
            if (allSelected) {
                filteredProducts.forEach((product) => next.delete(product.id));
            } else {
                filteredProducts.forEach((product) => {
                    next.set(product.id, {
                        id: product.id,
                        variantId: product.variants?.nodes?.[0]?.id,
                        price: product.variants?.nodes?.[0]?.price,
                    });
                });
            }
            return next;
        });
    };

    const toggleRow = (product) => {
        setSelectedProductsMap((current) => {
            const next = new Map(current);
            if (next.has(product.id)) {
                next.delete(product.id);
            } else {
                next.set(product.id, {
                    id: product.id,
                    variantId: product.variants?.nodes?.[0]?.id,
                    price: product.variants?.nodes?.[0]?.price,
                });
            }
            return next;
        });
    };

    useEffect(() => {
        const table = tableRef.current;
        if (!table) return;

        table.addEventListener("nextpage", handleNextPage);
        table.addEventListener("previouspage", handlePreviousPage);

        return () => {
            table.removeEventListener("nextpage", handleNextPage);
            table.removeEventListener("previouspage", handlePreviousPage);
        };
    }, [handleNextPage, handlePreviousPage]);

    useEffect(() => {
        if (bulkFetcher.state !== "idle" || !bulkResult) return;

        if (bulkResult.userErrors?.length) {
            shopify.toast.show(bulkResult.userErrors[0].message, { isError: true, duration: 3000 });
            return;
        }

        setSelectedProductsMap(new Map());
        const plural = bulkResult.count === 1 ? "" : "s";
        const message = bulkResult.bulk === "delete"
            ? format(t.deletedCount, { count: bulkResult.count, plural })
            : format(t.updatedCount, { count: bulkResult.count, plural });
        shopify.toast.show(message, { duration: 3000 });
    }, [bulkFetcher.state, bulkResult]);
//bulk edit status
    const submitBulkStatus = (event) => {
        event.preventDefault();
        bulkFetcher.submit(
            {
                intent: "bulkStatus",
                status: bulkStatus,
                items: JSON.stringify(selectedProducts),
            },
            { method: "post" },
        );
    };
//bulk edit price
    const submitBulkPrice = (event) => {
        event.preventDefault();
        bulkFetcher.submit(
            {
                intent: "bulkPrice",
                mode: bulkPriceMode,
                value: bulkPrice,
                items: JSON.stringify(selectedProducts),
            },
            { method: "post" },
        );
    };
//bulk delete tags
    const submitBulkTags = (event) => {
        event.preventDefault();
        bulkFetcher.submit(
            {
                intent: "bulkTags",
                tags: bulkTags,
                items: JSON.stringify(selectedProducts),
            },
            { method: "post" },
        );
    };
//bulkdelete
    const submitBulkDelete = (event) => {
        event.preventDefault();
        bulkFetcher.submit(
            {
                intent: "bulkDelete",
                items: JSON.stringify(selectedProducts),
            },
            { method: "post" },
        );
    };

    return (
        <s-page heading={t.heading}>
            <s-button slot="primary-action" href="/app/products/new">
                {t.addProduct}
            </s-button>

            {filter && FILTER_LABELS[filter] && (
                <s-banner tone="info" dismissible>
                    {format(t.showing, { label: FILTER_LABELS[filter] })} <s-link href="/app/products">{t.clearFilter}</s-link>
                </s-banner>
            )}

            <s-modal id="bulk-price-modal" heading={t.updatePriceHeading}>
                <s-stack direction="block" gap="base">
                    <s-text>
                        {format(t.setPriceFor, { count: selectedProducts.length, plural: selectedProducts.length === 1 ? "" : "s" })}
                    </s-text>
                    <s-choice-list
                        label={t.priceUpdateMethod}
                        labelAccessibilityVisibility="exclusive"
                        onChange={(event) => setBulkPriceMode(event.currentTarget.values[0])}
                    >
                        <s-choice value="set" selected={bulkPriceMode === "set"}>{t.setNewPrice}</s-choice>
                        <s-choice value="percent" selected={bulkPriceMode === "percent"}>{t.adjustByPercent}</s-choice>
                    </s-choice-list>
                    {bulkPriceMode === "percent" ? (
                        <s-number-field
                            label={t.percentLabel}
                            name="value"
                            value={bulkPrice}
                            onChange={(event) => setBulkPrice(event.currentTarget.value)}
                        />
                    ) : (
                        <s-money-field
                            label={t.newPrice}
                            name="value"
                            value={bulkPrice}
                            onChange={(event) => setBulkPrice(event.currentTarget.value)}
                        />
                    )}
                </s-stack>
                <s-button slot="primary-action" variant="primary" commandFor="bulk-price-modal" command="--hide" onClick={submitBulkPrice}>
                    {c.save}
                </s-button>
                <s-button slot="secondary-actions" variant="secondary" commandFor="bulk-price-modal" command="--hide">
                    {c.cancel}
                </s-button>
            </s-modal>

            <s-modal id="bulk-status-modal" heading={t.updateStatusHeading}>
                <s-stack direction="block" gap="base">
                    <s-text>
                        {format(t.setStatusFor, { count: selectedProducts.length, plural: selectedProducts.length === 1 ? "" : "s" })}
                    </s-text>
                    <s-choice-list
                        label={c.status}
                        labelAccessibilityVisibility="exclusive"
                        onChange={(event) => setBulkStatus(event.currentTarget.values[0])}
                    >
                        <s-choice value="ACTIVE" selected={bulkStatus === "ACTIVE"}>{c.active}</s-choice>
                        <s-choice value="DRAFT" selected={bulkStatus === "DRAFT"}>{c.draft}</s-choice>
                        <s-choice value="ARCHIVED" selected={bulkStatus === "ARCHIVED"}>{c.archived}</s-choice>
                    </s-choice-list>
                </s-stack>
                <s-button slot="primary-action" variant="primary" commandFor="bulk-status-modal" command="--hide" onClick={submitBulkStatus}>
                    {c.save}
                </s-button>
                <s-button slot="secondary-actions" variant="secondary" commandFor="bulk-status-modal" command="--hide">
                    {c.cancel}
                </s-button>
            </s-modal>

            <s-modal id="bulk-tags-modal" heading={t.updateTagsHeading}>
                <s-stack direction="block" gap="base">
                    <s-text>
                        {format(t.setTagsFor, { count: selectedProducts.length, plural: selectedProducts.length === 1 ? "" : "s" })}
                    </s-text>
                    <s-text-field
                        label={t.tagsLabel}
                        labelAccessibilityVisibility="exclusive"
                        name="tags"
                        placeholder={t.tagsPlaceholder}
                        value={bulkTags}
                        onInput={(event) => setBulkTags(event.currentTarget.value)}
                    />
                </s-stack>
                <s-button slot="primary-action" variant="primary" commandFor="bulk-tags-modal" command="--hide" onClick={submitBulkTags}>
                    {c.save}
                </s-button>
                <s-button slot="secondary-actions" variant="secondary" commandFor="bulk-tags-modal" command="--hide">
                    {c.cancel}
                </s-button>
            </s-modal>

            <s-modal id="bulk-delete-modal" heading={t.deleteHeading}>
                <s-stack direction="block" gap="base">
                    <s-text>
                        {format(t.deleteConfirm, { count: selectedProducts.length, plural: selectedProducts.length === 1 ? "" : "s" })}
                    </s-text>
                </s-stack>
                <s-button slot="primary-action" variant="primary" tone="critical" commandFor="bulk-delete-modal" command="--hide" onClick={submitBulkDelete}>
                    {c.delete}
                </s-button>
                <s-button slot="secondary-actions" variant="secondary" commandFor="bulk-delete-modal" command="--hide">
                    {c.cancel}
                </s-button>
            </s-modal>

            <s-section padding="none" accessibilityLabel="Products table section">
                <s-table
                    ref={tableRef}
                    paginate
                    hasNextPage={products.pageInfo.hasNextPage}
                    hasPreviousPage={products.pageInfo.hasPreviousPage}
                >
                    <s-stack slot="filters" direction="block" gap="none">
                        {selectedProducts.length > 0 && (
                            <s-box
                                padding="small"
                                background="strong"
                                borderRadius="base base none none"
                            >
                                <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
                                    <s-text>{format(t.selectedCount, { count: selectedProducts.length })}</s-text>
                                    <s-stack direction="inline" gap="small">
                                        <s-button commandFor="bulk-price-modal" variant="secondary">
                                            {t.editPrice}
                                        </s-button>
                                        <s-button commandFor="bulk-status-modal" variant="secondary">
                                            {t.editStatus}
                                        </s-button>
                                        <s-button commandFor="bulk-tags-modal" variant="secondary">
                                            {t.editTags}
                                        </s-button>
                                        <s-button commandFor="bulk-delete-modal" variant="secondary" tone="critical">
                                            {c.delete}
                                        </s-button>
                                    </s-stack>
                                </s-stack>
                            </s-box>
                        )}
                        <s-grid gap="small-200" gridTemplateColumns="1fr auto">
                            <s-text-field
                                label={t.searchProducts}
                                labelAccessibilityVisibility="exclusive"
                                icon="search"
                                placeholder={t.searchAllProducts}
                                value={searchInput}
                                onInput={(event) => setSearchInput(event.currentTarget.value)}
                            />
                            <s-button
                                icon="sort"
                                variant="secondary"
                                accessibilityLabel={c.sort}
                                interestFor="sort-tooltip"
                                commandFor="sort-actions"
                            />
                            <s-tooltip id="sort-tooltip">
                                <s-text>{c.sort}</s-text>
                            </s-tooltip>
                            <s-popover id="sort-actions">
                                <s-stack gap="none">
                                    <s-box padding="small">
                                        <s-choice-list
                                            label={c.sortBy}
                                            onChange={(event) => updateParam("sort", event.currentTarget.values[0])}
                                        >
                                            <s-choice value="product-title" selected={sort === "product-title"}>
                                                {t.productTitleSort}
                                            </s-choice>
                                            <s-choice value="inventory" selected={sort === "inventory"}>{t.inventory}</s-choice>
                                            <s-choice value="created" selected={sort === "created"}>{c.created}</s-choice>
                                        </s-choice-list>
                                    </s-box>
                                    <s-divider />
                                    <s-box padding="small">
                                        <s-choice-list
                                            label={c.orderBy}
                                            onChange={(event) => updateParam("order", event.currentTarget.values[0])}
                                        >
                                            <s-choice value="asc" selected={order === "asc"}>
                                                {c.aToZ}
                                            </s-choice>
                                            <s-choice value="desc" selected={order === "desc"}>{c.zToA}</s-choice>
                                        </s-choice-list>
                                    </s-box>
                                </s-stack>
                            </s-popover>
                        </s-grid>
                    </s-stack>
                    <s-table-header-row>
                        <s-table-header>
                            <s-checkbox
                                accessibilityLabel={t.selectAllProducts}
                                checked={allSelected}
                                onChange={toggleAll}
                            />
                        </s-table-header>
                        <s-table-header listSlot="primary">
                            {t.product}
                        </s-table-header>
                        <s-table-header format="numeric">{t.inventory}</s-table-header>
                        <s-table-header listSlot="secondary">{c.status}</s-table-header>
                        <s-table-header format="numeric">{t.price}</s-table-header>
                        <s-table-header>{t.updated}</s-table-header>
                        <s-table-header>{c.action}</s-table-header>
                    </s-table-header-row>

                    <s-table-body>
                        {filteredProducts.map((product) => (
                            <s-table-row key={product.id}>
                                <s-table-cell>
                                    <s-checkbox
                                        accessibilityLabel={`Select ${product.title}`}
                                        checked={selectedProductsMap.has(product.id)}
                                        onChange={() => toggleRow(product)}
                                    />
                                </s-table-cell>
                                <s-table-cell>
                                    <s-grid gridTemplateColumns="40px 1fr" gap="small" alignItems="center">
                                        <s-box
                                            border="base"
                                            borderRadius="base"
                                            overflow="hidden"
                                            inlineSize="40px"
                                            blockSize="40px"
                                        >
                                            {product.featuredImage?.url ? (
                                                <s-image
                                                    objectFit="cover"
                                                    src={product.featuredImage.url}
                                                    alt={product.featuredImage.altText || product.title}
                                                />
                                            ) : null}
                                        </s-box>
                                        <s-text>{product.title}</s-text>
                                    </s-grid>
                                </s-table-cell>
                                <s-table-cell>
                                    <s-text tone={product.totalInventory > 0 ? "auto" : "critical"}>
                                        {product.totalInventory > 0
                                            ? format(t.inStock, { count: product.totalInventory })
                                            : t.outOfStock}
                                    </s-text>
                                </s-table-cell>
                                <s-table-cell>
                                    <s-badge
                                        color="base"
                                        tone={
                                            product.status === "ACTIVE"
                                                ? "success"
                                                : product.status === "DRAFT"
                                                    ? "neutral"
                                                    : "neutral"
                                        }
                                    >
                                        {product.status === "ACTIVE" ? c.active : product.status === "DRAFT" ? c.draft : c.archived}
                                    </s-badge>
                                </s-table-cell>
                                <s-table-cell>
                                    {product.variants?.nodes?.[0]?.price != null
                                        ? currencyFormatter.format(Number(product.variants.nodes[0].price))
                                        : "—"}
                                </s-table-cell>
                                <s-table-cell>
                                    {new Date(product.updatedAt).toLocaleDateString()}
                                </s-table-cell>
                                <s-table-cell>
                                    <s-button
                                        icon="edit"
                                        variant="tertiary"
                                        href={`/app/products/${product.id.split("/").pop()}`}
                                        accessibilityLabel={`Edit ${product.title}`}
                                        interestFor={`edit-tooltip-${product.id.split("/").pop()}`}
                                    />
                                    <s-tooltip id={`edit-tooltip-${product.id.split("/").pop()}`}>
                                        <s-text>{c.edit}</s-text>
                                    </s-tooltip>
                                </s-table-cell>
                            </s-table-row>
                        ))}
                    </s-table-body>
                </s-table>
            </s-section>
        </s-page>
    );
}
