import { useLoaderData, useNavigate, useFetcher, useSearchParams } from "react-router";
import { useEffect, useRef, useCallback, useState } from "react";
import { authenticate } from "../shopify.server";
import { format, useLanguage } from "../context/LanguageContext";
  
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
    const intent = formData.get("intent") ?? "updateTitle";

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

    if (intent === "bulkPrice") {
        const price = formData.get("price");
        const items = JSON.parse(formData.get("items") || "[]");

        const results = await Promise.all(
            items.map(async ({ id, variantId }) => {
                const response = await admin.graphql(`
                    #graphql
                    mutation BulkUpdatePrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
                        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                            productVariants { id price }
                            userErrors { field message }
                        }
                    }
                `, { variables: { productId: id, variants: [{ id: variantId, price }] } });
                return (await response.json()).data.productVariantsBulkUpdate;
            }),
        );

        const userErrors = results.flatMap((result) => result.userErrors ?? []);
        return { bulk: "price", count: items.length, userErrors };
    }

    const productId = formData.get("productId");
    const title = formData.get("title");

    const response = await admin.graphql(`
        #graphql
        mutation UpdateProductTitle($product: ProductUpdateInput!) {
            productUpdate(product: $product) {
                product { id title }
                userErrors { field message }
            }
        }
    `, { variables: { product: { id: productId, title } } });

    const data = await response.json();
    return data.data.productUpdate;
};

//UI
export default function Products() {
    const { products, filter, search: initialSearch, sort, order } = useLoaderData();
    const { t: { common: c, products: t } } = useLanguage();
    const FILTER_LABELS = {
        active: t.filterActive,
        draft: t.filterDraft,
        out_of_stock: t.filterOutOfStock,
        low_inventory: t.filterLowInventory,
    };
    const [searchInput, setSearchInput] = useState(initialSearch);
    const [selectedIds, setSelectedIds] = useState(() => new Set());
    const [bulkStatus, setBulkStatus] = useState("ACTIVE");
    const [bulkPrice, setBulkPrice] = useState("");

    const fetcher = useFetcher();
    const bulkFetcher = useFetcher();

    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const tableRef = useRef(null);
    const updateResult = fetcher.data;
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
    //selects the only products which are selected by the user
    const selectedProducts = filteredProducts
    //selected ID has the particular ID or not 
        .filter((product) => selectedIds.has(product.id))
        //converting to object
        .map((product) => ({
            id: product.id,
            variantId: product.variants?.nodes?.[0]?.id,
        }));

    const allSelected = filteredProducts.length > 0 && selectedProducts.length === filteredProducts.length;

    const toggleAll = () => {
        if (allSelected) {
            setSelectedIds(new Set());
        } else {
            setSelectedIds(new Set(filteredProducts.map((product) => product.id)));
        }
    };

    const toggleRow = (id) => {
        setSelectedIds((current) => {
            const next = new Set(current);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
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
        if (bulkFetcher.state === "idle" && bulkResult && !bulkResult.userErrors?.length) {
            setSelectedIds(new Set());
        }
    }, [bulkFetcher.state, bulkResult]);

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

    const submitBulkPrice = (event) => {
        event.preventDefault();
        bulkFetcher.submit(
            {
                intent: "bulkPrice",
                price: bulkPrice,
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

            {updateResult?.userErrors?.length > 0 && (
                <s-banner tone="critical">
                    {updateResult.userErrors[0].message}
                </s-banner>
            )}
            {updateResult?.product && (
                <s-banner tone="success">
                    {t.titleUpdatedSuccess}
                </s-banner>
            )}
            {bulkResult?.userErrors?.length > 0 && (
                <s-banner tone="critical">
                    {bulkResult.userErrors[0].message}
                </s-banner>
            )}
            {bulkResult && !bulkResult.userErrors?.length && (
                <s-banner tone="success">
                    {format(t.updatedCount, { count: bulkResult.count, plural: bulkResult.count === 1 ? "" : "s" })}
                </s-banner>
            )}
            {filter && FILTER_LABELS[filter] && (
                <s-banner tone="info" dismissible>
                    {format(t.showing, { label: FILTER_LABELS[filter] })} <s-link href="/app/products">{t.clearFilter}</s-link>
                </s-banner>
            )}

            {selectedProducts.length > 0 && (
                <s-section padding="base">
                    <s-stack direction="inline" gap="base" alignItems="center">
                        <s-text>{format(t.selectedCount, { count: selectedProducts.length })}</s-text>
                        <s-button-group>
                            <s-button commandFor="bulk-status-modal" variant="secondary">
                                {t.editStatus}
                            </s-button>
                            <s-button commandFor="bulk-price-modal" variant="secondary">
                                {t.editPrice}
                            </s-button>
                            <s-button variant="tertiary" onClick={() => setSelectedIds(new Set())}>
                                {t.clearSelection}
                            </s-button>
                        </s-button-group>
                    </s-stack>
                </s-section>
            )}

            <s-modal id="bulk-status-modal" heading={t.updateStatusHeading}>
                <s-stack direction="block" gap="base">
                    <s-text>
                        {format(t.setStatusFor, { count: selectedProducts.length, plural: selectedProducts.length === 1 ? "" : "s" })}
                    </s-text>
                    <s-select
                        label={c.status}
                        name="status"
                        value={bulkStatus}
                        onChange={(event) => setBulkStatus(event.currentTarget.value)}
                    >
                        <s-option value="ACTIVE">{c.active}</s-option>
                        <s-option value="DRAFT">{c.draft}</s-option>
                    </s-select>
                    <s-button-group>
                        <s-button variant="primary" onClick={submitBulkStatus}>
                            {c.save}
                        </s-button>
                        <s-button commandFor="bulk-status-modal" command="--hide" variant="tertiary">
                            {c.cancel}
                        </s-button>
                    </s-button-group>
                </s-stack>
            </s-modal>

            <s-modal id="bulk-price-modal" heading={t.updatePriceHeading}>
                <s-stack direction="block" gap="base">
                    <s-text>
                        {format(t.setPriceFor, { count: selectedProducts.length, plural: selectedProducts.length === 1 ? "" : "s" })}
                    </s-text>
                    <s-money-field
                        label={t.newPrice}
                        name="price"
                        value={bulkPrice}
                        onChange={(event) => setBulkPrice(event.currentTarget.value)}
                    />
                    <s-button-group>
                        <s-button variant="primary" onClick={submitBulkPrice}>
                            {c.save}
                        </s-button>
                        <s-button commandFor="bulk-price-modal" command="--hide" variant="tertiary">
                            {c.cancel}
                        </s-button>
                    </s-button-group>
                </s-stack>
            </s-modal>

            <s-section padding="none" accessibilityLabel="Products table section">
                <s-table
                    ref={tableRef}
                    paginate
                    hasNextPage={products.pageInfo.hasNextPage}
                    hasPreviousPage={products.pageInfo.hasPreviousPage}
                >
                    <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr auto">
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
                        <s-table-header>{c.created}</s-table-header>
                        <s-table-header listSlot="secondary">{c.status}</s-table-header>
                        <s-table-header>{t.rename}</s-table-header>
                    </s-table-header-row>

                    <s-table-body>
                        {filteredProducts.map((product) => (
                            <s-table-row key={product.id}>
                                <s-table-cell>
                                    <s-checkbox
                                        accessibilityLabel={`Select ${product.title}`}
                                        checked={selectedIds.has(product.id)}
                                        onChange={() => toggleRow(product.id)}
                                    />
                                </s-table-cell>
                                <s-table-cell>
                                    <s-grid gridTemplateColumns="40px 1fr auto" gap="small" alignItems="center">
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
                                    </s-grid>
                                </s-table-cell>
                                <s-table-cell>{product.totalInventory ?? 0}</s-table-cell>
                                <s-table-cell>
                                    {new Date(product.createdAt).toLocaleDateString()}
                                </s-table-cell>
                                <s-table-cell>
                                    <s-badge color="base" tone={product.status === "ACTIVE" ? "success" : "neutral"}>
                                        {product.status === "ACTIVE" ? c.active : c.draft}
                                    </s-badge>
                                </s-table-cell>
                                <s-table-cell>
                                    <fetcher.Form method="post">
                                        <s-grid gridTemplateColumns="minmax(180px, 1fr) auto" gap="small" alignItems="center">
                                            <input type="hidden" name="productId" value={product.id} />
                                            <s-text-field
                                                label={`Title for ${product.title}`}
                                                labelAccessibilityVisibility="exclusive"
                                                name="title"
                                                defaultValue={product.title}
                                            />
                                            <s-button type="submit" variant="secondary">{c.save}</s-button>
                                        </s-grid>
                                    </fetcher.Form>
                                </s-table-cell>
                            </s-table-row>
                        ))}
                    </s-table-body>
                </s-table>
            </s-section>
        </s-page>
    );
}
