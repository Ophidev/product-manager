import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const STAT_FILTERS = {
    total: null,
    active: "status:active",
    draft: "status:draft",
    outOfStock: "inventory_total:0",
    lowInventory: "inventory_total:<=5",
};

export const loader = async ({ request }) => {
    const { admin } = await authenticate.admin(request);

    const statsResponse = await admin.graphql(`
        query DashboardStats {
            total: productsCount { count }
            active: productsCount(query: "status:active") { count }
            draft: productsCount(query: "status:draft") { count }
            outOfStock: productsCount(query: "inventory_total:0") { count }
            lowInventory: productsCount(query: "inventory_total:<=5") { count }
        }
    `);

    const recentResponse = await admin.graphql(`
        query RecentProducts($first: Int!) {
            products(first: $first, sortKey: UPDATED_AT, reverse: true) {
                nodes {
                    id
                    title
                    status
                    totalInventory
                    updatedAt
                    featuredImage { url altText }
                }
            }
        }
    `, { variables: { first: 5 } });

    const stats = (await statsResponse.json()).data;
    const recent = (await recentResponse.json()).data;

    return { stats, recentProducts: recent.products.nodes };
};

// eslint-disable-next-line react/prop-types
function StatTile({ label, value, filter, tone }) {
    const href = filter ? `/app/products?filter=${filter}` : "/app/products";

    return (
        <s-clickable href={href} padding="base" background="subdued" borderRadius="base">
            <s-stack direction="block" gap="small-200">
                <s-text color="subdued">{label}</s-text>
                <s-heading>
                    <s-text tone={tone}>{value}</s-text>
                </s-heading>
            </s-stack>
        </s-clickable>
    );
}

export default function Dashboard() {
    const { stats, recentProducts } = useLoaderData();

    return (
        <s-page heading="Dashboard">
            <s-section heading="Catalog overview">
                <s-grid gridTemplateColumns="repeat(5, 1fr)" gap="base">
                    <StatTile label="Total products" value={stats.total.count} filter={null} tone="neutral" />
                    <StatTile label="Active" value={stats.active.count} filter={STAT_FILTERS.active ? "active" : null} tone="success" />
                    <StatTile label="Draft" value={stats.draft.count} filter="draft" tone="neutral" />
                    <StatTile label="Out of stock" value={stats.outOfStock.count} filter="out_of_stock" tone="critical" />
                    <StatTile label="Low inventory" value={stats.lowInventory.count} filter="low_inventory" tone="caution" />
                </s-grid>
            </s-section>

            <s-section heading="Recently updated products" padding= "2px">
                {recentProducts.length === 0 ? (
                    <s-box padding="base">
                        <s-text color="subdued">No products yet. Products you edit will show up here.</s-text>
                    </s-box>
                ) : (
                    <s-table variant="auto">
                        <s-table-header-row>
                            <s-table-header listSlot="primary">Product</s-table-header>
                            <s-table-header format="numeric">Inventory</s-table-header>
                            <s-table-header>Updated</s-table-header>
                            <s-table-header listSlot="secondary">Status</s-table-header>
                        </s-table-header-row>
                        <s-table-body>
                            {recentProducts.map((product) => (
                                <s-table-row key={product.id}>
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
                                        {new Date(product.updatedAt).toLocaleDateString()}
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
                )}
            </s-section>
        </s-page>
    );
}

export const headers = (headersArgs) => {
    return boundary.headers(headersArgs);
};
