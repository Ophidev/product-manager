import { useLoaderData, useNavigate } from "react-router"; //useNavigate() will let us change the URL when the user clicks Next/Previous.
import { useEffect, useRef, useCallback, useState } from "react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);

    const url = new URL(request.url);
    const after = url.searchParams.get("after");
    const before = url.searchParams.get("before");

    let response;

    if (before) {
        response = await admin.graphql(`
            #graphql
            query GetProducts($last: Int!, $before: String!) {
                products(last: $last, before: $before) {
                    nodes { id title status totalInventory createdAt featuredImage { url altText } }
                    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
                }
            }
        `, { variables: { last: 10, before } });
    } else if (after) {
        response = await admin.graphql(`
            #graphql
            query GetProducts($first: Int!, $after: String!) {
                products(first: $first, after: $after) {
                    nodes { id title status totalInventory createdAt featuredImage { url altText } }
                    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
                }
            }
        `, { variables: { first: 10, after } });
    } else {
        response = await admin.graphql(`
            #graphql
            query GetProducts($first: Int!) {
                products(first: $first) {
                    nodes { id title status totalInventory createdAt featuredImage { url altText } }
                    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
                }
            }
        `, { variables: { first: 10 } });
    }

    const data = await response.json();
    return data.data;
};
//use loader data is been used to fetch shopify product data for list view 
//import authenticate from ../shopify.server is used for 
//here is the ui for the shopify block  using web-component  

export default function Products() {
    const { products } = useLoaderData();
    const [search, setSearch] = useState("");

    const navigate = useNavigate();
    const tableRef = useRef(null);

    const handleNextPage = useCallback(() => {
        const cursor = products.pageInfo.endCursor;

        navigate(
            `/app/products?after=${encodeURIComponent(cursor)}`
        );
    }, [products.pageInfo.endCursor, navigate]);

    const handlePreviousPage = useCallback(() => {
        const cursor = products.pageInfo.startCursor;

        navigate(
            `/app/products?before=${encodeURIComponent(cursor)}`
        );
    }, [products.pageInfo.startCursor, navigate]);

    const filteredProducts = products.nodes.filter((product) =>
        product.title.toLowerCase().includes(search.toLowerCase()),
    );

    useEffect(() => {
        const table = tableRef.current;
        if (!table) return;

        table.addEventListener("nextpage", handleNextPage);
        table.addEventListener("previouspage", handlePreviousPage);
//pagination 
        return () => {
            table.removeEventListener("nextpage", handleNextPage);
            table.removeEventListener("previouspage", handlePreviousPage);
        };
    }, [handleNextPage, handlePreviousPage]);
//index table is been used by shopify web component for the live status by replacing product and status f
    return (
        <s-page heading="Products">
            <s-section padding="none" accessibilityLabel="Puzzles table section">
                <s-table
                    ref={tableRef}
                    paginate
                    hasNextPage={products.pageInfo.hasNextPage}
                    hasPreviousPage={products.pageInfo.hasPreviousPage}
                >
                    <s-grid slot="filters" gap="small-200" gridTemplateColumns="1fr auto">
                        <s-text-field
                            label="Search puzzles"
                            labelAccessibilityVisibility="exclusive"
                            icon="search"
                            placeholder="Searching all puzzles"
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
                                        <s-choice value="puzzle-name" selected>
                                            Puzzle name
                                        </s-choice>
                                        <s-choice value="pieces">Pieces</s-choice>
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
                        <s-table-header listSlot="primary">
                            Puzzle
                        </s-table-header>
                        <s-table-header format="numeric">Pieces</s-table-header>
                        <s-table-header>Created</s-table-header>
                        <s-table-header listSlot="secondary">Status</s-table-header>
                    </s-table-header-row>

                    <s-table-body>
                        {filteredProducts.map((product) => (
                            <s-table-row key={product.id}>
                                <s-table-cell>
                                    <s-stack direction="inline" gap="small" alignItems="center">
                                        <s-clickable
                                            href={`shopify://admin/products/${product.id.split("/").pop()}`}
                                            accessibilityLabel={`${product.title} puzzle thumbnail`}
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
                            </s-table-row>
                        ))}
                    </s-table-body>
                </s-table>
            </s-section>
        </s-page>
    );
}