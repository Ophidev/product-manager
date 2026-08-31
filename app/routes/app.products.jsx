import { useLoaderData, useNavigate, useFetcher, useSearchParams } from "react-router";
import { useEffect, useRef, useCallback, useState } from "react";
import { authenticate } from "../shopify.server";

const FILTER_QUERIES = {
    active: "status:active",
    draft: "status:draft",
    out_of_stock: "inventory_total:0",
    low_inventory: "inventory_total:<=5",
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

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const after = url.searchParams.get("after");
    const before = url.searchParams.get("before");
    const filter = url.searchParams.get("filter");
    const query = FILTER_QUERIES[filter] ?? null;

    let response;

    if (before) {
        response = await admin.graphql(`
            #graphql
            query GetProducts($last: Int!, $before: String!, $query: String) {
                products(last: $last, before: $before, query: $query) {
                    nodes { ${PRODUCT_FIELDS} }
                    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
                }
            }
        `, { variables: { last: 10, before, query } });
    } else if (after) {
        response = await admin.graphql(`
            #graphql
            query GetProducts($first: Int!, $after: String!, $query: String) {
                products(first: $first, after: $after, query: $query) {
                    nodes { ${PRODUCT_FIELDS} }
                    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
                }
            }
        `, { variables: { first: 10, after, query } });
    } else {
        response = await admin.graphql(`
            #graphql
            query GetProducts($first: Int!, $query: String) {
                products(first: $first, query: $query) {
                    nodes { ${PRODUCT_FIELDS} }
                    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
                }
            }
        `, { variables: { first: 10, query } });
    }

    const data = await response.json();
    return { ...data.data, filter };
};

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

const FILTER_LABELS = {
    active: "Active products",
    draft: "Draft products",
    out_of_stock: "Out of stock products",
    low_inventory: "Low inventory products",
};

export default function Products() {
    const { products, filter } = useLoaderData();
    const [search, setSearch] = useState("");
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

    const filteredProducts = products.nodes.filter((product) =>
        product.title.toLowerCase().includes(search.toLowerCase()),
    );

    const selectedProducts = filteredProducts
        .filter((product) => selectedIds.has(product.id))
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
        <s-page heading="Products">
            {updateResult?.userErrors?.length > 0 && (
                <s-banner tone="critical">
                    {updateResult.userErrors[0].message}
                </s-banner>
            )}
            {updateResult?.product && (
                <s-banner tone="success">
                    Product title updated successfully.
                </s-banner>
            )}
            {bulkResult?.userErrors?.length > 0 && (
                <s-banner tone="critical">
                    {bulkResult.userErrors[0].message}
                </s-banner>
            )}
            {bulkResult && !bulkResult.userErrors?.length && (
                <s-banner tone="success">
                    Updated {bulkResult.count} product{bulkResult.count === 1 ? "" : "s"}.
                </s-banner>
            )}
            {filter && FILTER_LABELS[filter] && (
                <s-banner tone="info" dismissible>
                    Showing: {FILTER_LABELS[filter]}. <s-link href="/app/products">Clear filter</s-link>
                </s-banner>
            )}

            {selectedProducts.length > 0 && (
                <s-section padding="base">
                    <s-stack direction="inline" gap="base" alignItems="center">
                        <s-text>{selectedProducts.length} selected</s-text>
                        <s-button-group>
                            <s-button commandFor="bulk-status-modal" variant="secondary">
                                Edit status
                            </s-button>
                            <s-button commandFor="bulk-price-modal" variant="secondary">
                                Edit price
                            </s-button>
                            <s-button variant="tertiary" onClick={() => setSelectedIds(new Set())}>
                                Clear selection
                            </s-button>
                        </s-button-group>
                    </s-stack>
                </s-section>
            )}

            <s-modal id="bulk-status-modal" heading="Update status">
                <s-stack direction="block" gap="base">
                    <s-text>
                        Set the status for {selectedProducts.length} selected product
                        {selectedProducts.length === 1 ? "" : "s"}.
                    </s-text>
                    <s-select
                        label="Status"
                        name="status"
                        value={bulkStatus}
                        onChange={(event) => setBulkStatus(event.currentTarget.value)}
                    >
                        <s-option value="ACTIVE">Active</s-option>
                        <s-option value="DRAFT">Draft</s-option>
                    </s-select>
                    <s-button-group>
                        <s-button variant="primary" onClick={submitBulkStatus}>
                            Save
                        </s-button>
                        <s-button commandFor="bulk-status-modal" command="--hide" variant="tertiary">
                            Cancel
                        </s-button>
                    </s-button-group>
                </s-stack>
            </s-modal>

            <s-modal id="bulk-price-modal" heading="Update price">
                <s-stack direction="block" gap="base">
                    <s-text>
                        Set a new price for {selectedProducts.length} selected product
                        {selectedProducts.length === 1 ? "" : "s"}. This updates each product&apos;s first variant.
                    </s-text>
                    <s-money-field
                        label="New price"
                        name="price"
                        value={bulkPrice}
                        onChange={(event) => setBulkPrice(event.currentTarget.value)}
                    />
                    <s-button-group>
                        <s-button variant="primary" onClick={submitBulkPrice}>
                            Save
                        </s-button>
                        <s-button commandFor="bulk-price-modal" command="--hide" variant="tertiary">
                            Cancel
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
                            label="Search products"
                            labelAccessibilityVisibility="exclusive"
                            icon="search"
                            placeholder="Search all products"
                            value={search}
                            onInput={(event) => setSearch(event.currentTarget.value)}
                        />
                        <s-button
                            icon="sort"
                            variant="secondary"
                            accessibilityLabel="Sort"
                            interestFor="sort-tooltip"
                            commandFor="sort-actions"
                        />
                        <s-tooltip id="sort-tooltip">
                            <s-text>Sort</s-text>
                        </s-tooltip>
                        <s-popover id="sort-actions">
                            <s-stack gap="none">
                                <s-box padding="small">
                                    <s-choice-list label="Sort by" name="Sort by">
                                        <s-choice value="product-title" selected>
                                            Product title
                                        </s-choice>
                                        <s-choice value="inventory">Inventory</s-choice>
                                        <s-choice value="created">Created</s-choice>
                                        <s-choice value="status">Status</s-choice>
                                    </s-choice-list>
                                </s-box>
                                <s-divider />
                                <s-box padding="small">
                                    <s-choice-list label="Order by" name="Order by">
                                        <s-choice value="product-title" selected>
                                            A-Z
                                        </s-choice>
                                        <s-choice value="created">Z-A</s-choice>
                                    </s-choice-list>
                                </s-box>
                            </s-stack>
                        </s-popover>
                    </s-grid>
                    <s-table-header-row>
                        <s-table-header>
                            <s-checkbox
                                label="Select all products"
                                checked={allSelected}
                                onChange={toggleAll}
                            />
                        </s-table-header>
                        <s-table-header listSlot="primary">
                            Product
                        </s-table-header>
                        <s-table-header format="numeric">Inventory</s-table-header>
                        <s-table-header>Created</s-table-header>
                        <s-table-header listSlot="secondary">Status</s-table-header>
                        <s-table-header>Rename</s-table-header>
                    </s-table-header-row>

                    <s-table-body>
                        {filteredProducts.map((product) => (
                            <s-table-row key={product.id}>
                                <s-table-cell>
                                    <s-checkbox
                                        label={`Select ${product.title}`}
                                        checked={selectedIds.has(product.id)}
                                        onChange={() => toggleRow(product.id)}
                                    />
                                </s-table-cell>
                                <s-table-cell>
                                    <s-stack direction="inline" gap="small" alignItems="center">
                                        <s-clickable
                                            href={`shopify://admin/products/${product.id.split("/").pop()}`}
                                            accessibilityLabel={`${product.title} thumbnail`}
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
                                        </s-clickable>
                                        <s-link href={`shopify://admin/products/${product.id.split("/").pop()}`}>
                                            {product.title}
                                        </s-link>
                                    </s-stack>
                                </s-table-cell>
                                <s-table-cell>{product.totalInventory ?? 0}</s-table-cell>
                                <s-table-cell>
                                    {new Date(product.createdAt).toLocaleDateString()}
                                </s-table-cell>
                                <s-table-cell>
                                    <s-badge color="base" tone={product.status === "ACTIVE" ? "success" : "neutral"}>
                                        {product.status === "ACTIVE" ? "Active" : "Draft"}
                                    </s-badge>
                                </s-table-cell>
                                <s-table-cell>
                                    <fetcher.Form method="post">
                                        <s-grid gridTemplateColumns="1fr auto" gap="small-200">
                                            <input type="hidden" name="productId" value={product.id} />
                                            <s-text-field
                                                label={`Title for ${product.title}`}
                                                labelAccessibilityVisibility="exclusive"
                                                name="title"
                                                defaultValue={product.title}
                                            />
                                            <s-button type="submit" variant="secondary">Save</s-button>
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
